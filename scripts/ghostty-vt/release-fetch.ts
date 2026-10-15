// Fetches a libghostty-vt pin from Ghostty's release channels and verifies it, with
// `fetch` injected so it runs on fakes in tests (service, ADR 041, ADR 042, ADR 059).
//
// Where Ghostty publishes the wasm (.github/workflows/release-tip.yml, build-lib-vt-wasm):
// - tip.files.ghostty.org/<sha>/ghostty-vt-small.wasm: per commit, unsigned.
// - The GitHub `tip` prerelease: the current tip's wasm and .minisig, overwritten by every
//   tip build. A signature can only be captured while the pinned commit is `tip`.
//
// The wasm does not record its commit (`ghostty_build_info` reports 0.1.0-dev), so the
// binding to <sha> is: `tip` points at <sha> before and after the download, and the GitHub
// asset has the same sha256 as the commit-addressed one. The signature by Ghostty's release
// key (PACKAGING.md) says Ghostty's CI built those bytes. Both are recorded in the sidecar.

import { inspectWasm } from './inspect-wasm';
import { sha256, verifyMinisign } from './minisign';
import {
  GHOSTTY_MINISIGN_PUBKEY,
  LICENSE_NOTE,
  type PinnedRelease,
  type Sidecar,
  WASM_FILE,
} from './sidecar';

/** Ghostty's GitHub repository, for the API and raw file URLs. */
export const REPO = 'ghostty-org/ghostty';
/** The per-commit, unsigned wasm host. */
export const R2 = 'https://tip.files.ghostty.org';
/** The GitHub `tip` prerelease's download folder. */
export const GH_TIP = `https://github.com/${REPO}/releases/download/tip`;

/** The part of `fetch` the release fetch uses, so a fake needs no more. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** What fetching a pin depends on; production defaults come from `releaseFetchDeps()`. */
export interface ReleaseFetchDeps {
  fetch: FetchFn;
  /** A GitHub token for the API's rate limit, if one is set. */
  token?: string;
  /** The key the signature must verify against. */
  publicKey: string;
  now(): Date;
}

/** The real network, the token from GITHUB_TOKEN or GH_TOKEN, and Ghostty's release key. */
export function releaseFetchDeps(overrides: Partial<ReleaseFetchDeps> = {}): ReleaseFetchDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    publicKey: GHOSTTY_MINISIGN_PUBKEY,
    now: () => new Date(),
    ...overrides,
  };
}

interface GitRef {
  object: { type: string; sha: string };
}

async function get(url: string, deps: ReleaseFetchDeps): Promise<Uint8Array<ArrayBuffer>> {
  const res = await deps.fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function gh<T>(apiPath: string, deps: ReleaseFetchDeps): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;
  const res = await deps.fetch(`https://api.github.com/repos/${REPO}/${apiPath}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${apiPath}: ${res.status}`);
  return (await res.json()) as T;
}

/** The commit the `tip` tag points at, through an annotated tag if it is one. */
export async function tipCommit(deps: ReleaseFetchDeps): Promise<string> {
  const ref = await gh<GitRef>('git/ref/tags/tip', deps);
  if (ref.object.type === 'commit') return ref.object.sha;
  return (await gh<GitRef>(`git/tags/${ref.object.sha}`, deps)).object.sha;
}

/** The downloads of one pin, taken while `tip` is `commit` before and after. */
interface Downloads {
  url: string;
  bytes: Uint8Array<ArrayBuffer>;
  hash: string;
  minisig: string;
  license: Uint8Array<ArrayBuffer>;
}

async function downloadAtTip(commit: string, deps: ReleaseFetchDeps): Promise<Downloads> {
  const tipBefore = await tipCommit(deps);
  if (tipBefore !== commit) {
    throw new Error(
      `${commit} is not the current tip (${tipBefore}); its .minisig is only published while it is tip`,
    );
  }
  const url = `${R2}/${commit}/${WASM_FILE}`;
  const bytes = await get(url, deps);
  const hash = sha256(bytes);
  const ghBytes = await get(`${GH_TIP}/${WASM_FILE}`, deps);
  const minisig = new TextDecoder().decode(await get(`${GH_TIP}/${WASM_FILE}.minisig`, deps));
  const license = await get(`https://raw.githubusercontent.com/${REPO}/${commit}/LICENSE`, deps);
  const tipAfter = await tipCommit(deps);
  if (tipAfter !== commit) throw new Error(`tip moved to ${tipAfter} during the download; rerun`);
  if (sha256(ghBytes) !== hash) {
    throw new Error(`GitHub tip asset sha256 ${sha256(ghBytes)} != ${url} ${hash}; rerun later`);
  }
  const release = await gh<{ assets?: { name: string; digest?: string }[] }>(
    'releases/tags/tip',
    deps,
  );
  const digest = release.assets?.find((a) => a.name === WASM_FILE)?.digest?.replace(/^sha256:/, '');
  if (digest && digest !== hash) throw new Error(`GitHub asset digest ${digest} != ${hash}`);
  return { url, bytes, hash, minisig, license };
}

/**
 * Fetches the wasm of Ghostty `commit` while it is `tip`, checks it against the GitHub
 * asset, its signature and its build info, and returns the pin with its sidecar.
 *
 * @throws If `commit` is not a full sha, is not tip, or any check fails.
 */
export async function fetchRelease(commit: string, deps: ReleaseFetchDeps): Promise<PinnedRelease> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit needs a full 40-character sha');
  const { url, bytes, hash, minisig, license } = await downloadAtTip(commit, deps);
  const sig = verifyMinisign(bytes, minisig, deps.publicKey);
  if (sig.file !== WASM_FILE) throw new Error(`signature is for ${sig.file}, not ${WASM_FILE}`);
  const wasm = await inspectWasm(bytes);
  if (wasm.buildInfo.optimize !== 'ReleaseSmall') {
    throw new Error(`${WASM_FILE} is ${wasm.buildInfo.optimize}, not ReleaseSmall`);
  }
  const commitInfo = await gh<{ commit?: { committer?: { date?: string } } }>(
    `commits/${commit}`,
    deps,
  ).catch(() => undefined);

  const sidecar: Sidecar = {
    repo: `https://github.com/${REPO}`,
    commit,
    commitDate: commitInfo?.commit?.committer?.date,
    url,
    file: WASM_FILE,
    variant: 'ReleaseSmall',
    size: bytes.byteLength,
    sha256: hash,
    minisig: `${WASM_FILE}.minisig`,
    minisigSource: `${GH_TIP}/${WASM_FILE}.minisig (tip == ${commit})`,
    publicKey: deps.publicKey,
    signature: {
      keyId: sig.keyId,
      algorithm: sig.algorithm,
      trustedComment: sig.trustedComment,
      signedAt: sig.timestamp ? new Date(sig.timestamp * 1000).toISOString() : undefined,
    },
    verifiedAt: deps.now().toISOString(),
    license: LICENSE_NOTE,
    wasm,
  };
  return { bytes, minisig, license, sidecar };
}
