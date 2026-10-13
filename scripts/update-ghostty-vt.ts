/**
 * Vendors and verifies Ghostty's official libghostty-vt wasm (ReleaseSmall) into
 * src/client/vendor/ghostty-vt/ (ADR 041, ADR 042).
 *
 *   bun scripts/update-ghostty-vt.ts --commit <sha>   fetch and verify a new pin (network)
 *   bun scripts/update-ghostty-vt.ts --verify         re-check the committed pin (offline)
 *
 * Where Ghostty publishes the wasm (.github/workflows/release-tip.yml, build-lib-vt-wasm):
 * - tip.files.ghostty.org/<sha>/ghostty-vt-small.wasm: per commit, unsigned.
 * - The GitHub `tip` prerelease: the current tip's wasm and .minisig, overwritten by every
 *   tip build. A signature can only be captured while the pinned commit is `tip`.
 *
 * The wasm does not record its commit (`ghostty_build_info` reports 0.1.0-dev), so the
 * binding to <sha> is: `tip` points at <sha> before and after the download, and the GitHub
 * asset has the same sha256 as the commit-addressed one. The signature by Ghostty's release
 * key (PACKAGING.md) says Ghostty's CI built those bytes. Both are recorded in the sidecar.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Ghostty's minisign release key, from Ghostty's PACKAGING.md. */
export const GHOSTTY_MINISIGN_PUBKEY = 'RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV';
export const WASM_FILE = 'ghostty-vt-small.wasm';
export const VENDOR_DIR = path.resolve(
  import.meta.dir,
  '..',
  'src',
  'client',
  'vendor',
  'ghostty-vt',
);

const REPO = 'ghostty-org/ghostty';
const R2 = 'https://tip.files.ghostty.org';
const GH_TIP = `https://github.com/${REPO}/releases/download/tip`;
const LICENSE_NOTE = 'MIT (Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors; LICENSE)';

/** Exports the binding needs; a pin without them is refused before it is written. */
const REQUIRED_EXPORTS = [
  'memory',
  '__indirect_function_table',
  'ghostty_type_json',
  'ghostty_wasm_alloc',
  'ghostty_wasm_free',
  'ghostty_build_info',
  'ghostty_terminal_new',
  'ghostty_terminal_free',
  'ghostty_terminal_vt_write',
  'ghostty_terminal_resize',
  'ghostty_terminal_scroll_viewport',
  'ghostty_render_state_new',
  'ghostty_render_state_update',
  'ghostty_key_encoder_encode',
];

export interface MinisigResult {
  /** Key id as minisign prints it (big-endian hex). */
  keyId: string;
  /** `ED`: signature over BLAKE2b-512 of the file; `Ed`: over the file itself. */
  algorithm: 'Ed' | 'ED';
  trustedComment: string;
  timestamp?: number;
  file?: string;
}

/** The JSON sidecar written next to the wasm. */
export interface Sidecar {
  repo: string;
  commit: string;
  commitDate?: string;
  url: string;
  file: string;
  variant: 'ReleaseSmall';
  size: number;
  sha256: string;
  minisig: string;
  minisigSource: string;
  publicKey: string;
  signature: {
    keyId: string;
    algorithm: string;
    trustedComment: string;
    signedAt?: string;
  };
  verifiedAt: string;
  license: string;
  wasm: Awaited<ReturnType<typeof inspectWasm>>;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verifies a minisign signature over `data`: the Ed25519 signature (over BLAKE2b-512 of the
 * data for `ED`) and the global signature over the trusted comment, both against `publicKey`.
 *
 * @throws If the signature, its key id or its trusted comment does not verify.
 */
export function verifyMinisign(
  data: Uint8Array,
  minisigText: string,
  publicKey: string,
): MinisigResult {
  const pk = Buffer.from(publicKey, 'base64');
  if (pk.length !== 42 || pk.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('minisign: bad public key');
  }
  const pkKeyId = pk.subarray(2, 10);

  const lines = minisigText.replace(/\r/g, '').split('\n');
  if (!lines[0]?.startsWith('untrusted comment:')) {
    throw new Error('minisign: missing untrusted comment');
  }
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  if (sig.length !== 74) throw new Error(`minisign: signature is ${sig.length} bytes, want 74`);
  const algorithm = sig.toString('latin1', 0, 2);
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`minisign: unknown algorithm ${algorithm}`);
  }
  const keyId = sig.subarray(2, 10);
  const sigBytes = sig.subarray(10, 74);
  const tcPrefix = 'trusted comment: ';
  if (!lines[2]?.startsWith(tcPrefix)) throw new Error('minisign: missing trusted comment');
  const trustedComment = lines[2].slice(tcPrefix.length);
  const globalSig = Buffer.from(lines[3] ?? '', 'base64');
  if (globalSig.length !== 64) throw new Error('minisign: bad global signature');

  const hexId = (b: Uint8Array) => Buffer.from(b).reverse().toString('hex').toUpperCase();
  if (!keyId.equals(pkKeyId)) {
    throw new Error(`minisign: signed by key ${hexId(keyId)}, expected ${hexId(pkKeyId)}`);
  }
  // Raw Ed25519 key in an SPKI DER wrapper for node:crypto.
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk.subarray(10, 42)]),
    format: 'der',
    type: 'spki',
  });
  const message =
    algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : Buffer.from(data);
  if (!edVerify(null, message, key, sigBytes)) {
    throw new Error('minisign: file signature is invalid');
  }
  const signedComment = Buffer.concat([sigBytes, Buffer.from(trustedComment, 'utf8')]);
  if (!edVerify(null, signedComment, key, globalSig)) {
    throw new Error('minisign: trusted comment signature is invalid');
  }
  const ts = /timestamp:(\d+)/.exec(trustedComment)?.[1];
  return {
    keyId: hexId(keyId),
    algorithm,
    trustedComment,
    timestamp: ts ? Number(ts) : undefined,
    file: /file:([^\t]+)/.exec(trustedComment)?.[1],
  };
}

/**
 * Instantiates the wasm, checks the exports the binding needs and reads `ghostty_build_info`.
 *
 * @throws If the module does not validate or lacks a required export.
 */
export async function inspectWasm(bytes: Uint8Array<ArrayBuffer>) {
  if (!WebAssembly.validate(bytes)) throw new Error('wasm: WebAssembly.validate failed');
  const mod = new WebAssembly.Module(bytes);
  const exports = WebAssembly.Module.exports(mod);
  const names = new Set(exports.map((e) => e.name));
  const missing = REQUIRED_EXPORTS.filter((n) => !names.has(n));
  if (missing.length) throw new Error(`wasm: missing exports ${missing.join(', ')}`);
  const instance = await WebAssembly.instantiate(mod, {});
  const ex = instance.exports as {
    memory: WebAssembly.Memory;
    ghostty_wasm_alloc(len: number): number;
    ghostty_wasm_free(ptr: number, len: number): void;
    ghostty_build_info(id: number, out: number): number;
  };
  const out = ex.ghostty_wasm_alloc(16);
  const query = (id: number) => {
    const rc = ex.ghostty_build_info(id, out);
    if (rc !== 0) throw new Error(`wasm: ghostty_build_info(${id}) returned ${rc}`);
    return new DataView(ex.memory.buffer);
  };
  const str = (id: number) => {
    const view = query(id);
    const ptr = view.getUint32(out, true);
    const len = view.getUint32(out + 4, true);
    return new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, len));
  };
  const bool = (id: number) => query(id).getUint8(out) !== 0;
  const optimize = query(4).getUint32(out, true);
  const buildInfo = {
    version: str(5),
    versionBuild: str(10),
    optimize: ['Debug', 'ReleaseSafe', 'ReleaseSmall', 'ReleaseFast'][optimize] ?? String(optimize),
    simd: bool(1),
    kittyGraphics: bool(2),
    tmuxControlMode: bool(3),
  };
  ex.ghostty_wasm_free(out, 16);
  return {
    imports: WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}:${i.kind}`),
    exportCount: exports.length,
    functionExports: exports.filter((e) => e.kind === 'function').length,
    nonFunctionExports: exports
      .filter((e) => e.kind !== 'function')
      .map((e) => `${e.name}:${e.kind}`),
    initialMemoryBytes: ex.memory.buffer.byteLength,
    buildInfo,
  };
}

/**
 * Re-checks a vendored pin offline: size, sha256, signature against `publicKey`, and the
 * signed file name.
 *
 * @throws On any mismatch.
 */
export function verifyPinned(
  dir: string,
  publicKey: string,
): { sidecar: Sidecar; sig: MinisigResult } {
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(dir, `${WASM_FILE}.json`), 'utf8'),
  ) as Sidecar;
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, sidecar.file)));
  if (bytes.byteLength !== sidecar.size) {
    throw new Error(`${sidecar.file}: size ${bytes.byteLength} != sidecar ${sidecar.size}`);
  }
  const hash = sha256(bytes);
  if (hash !== sidecar.sha256)
    throw new Error(`${sidecar.file}: sha256 ${hash} != sidecar ${sidecar.sha256}`);
  const sig = verifyMinisign(
    bytes,
    fs.readFileSync(path.join(dir, sidecar.minisig), 'utf8'),
    publicKey,
  );
  if (sig.file !== sidecar.file)
    throw new Error(`signature is for ${sig.file}, not ${sidecar.file}`);
  return { sidecar, sig };
}

async function get(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function gh<T>(apiPath: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${REPO}/${apiPath}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${apiPath}: ${res.status}`);
  return (await res.json()) as T;
}

interface GitRef {
  object: { type: string; sha: string };
}

async function tipCommit(): Promise<string> {
  const ref = await gh<GitRef>('git/ref/tags/tip');
  if (ref.object.type === 'commit') return ref.object.sha;
  return (await gh<GitRef>(`git/tags/${ref.object.sha}`)).object.sha;
}

async function update(commit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit needs a full 40-character sha');
  const tipBefore = await tipCommit();
  if (tipBefore !== commit) {
    throw new Error(
      `${commit} is not the current tip (${tipBefore}); its .minisig is only published while it is tip`,
    );
  }
  const url = `${R2}/${commit}/${WASM_FILE}`;
  const bytes = await get(url);
  const hash = sha256(bytes);
  const ghBytes = await get(`${GH_TIP}/${WASM_FILE}`);
  const minisig = new TextDecoder().decode(await get(`${GH_TIP}/${WASM_FILE}.minisig`));
  const license = await get(`https://raw.githubusercontent.com/${REPO}/${commit}/LICENSE`);
  const tipAfter = await tipCommit();
  if (tipAfter !== commit) throw new Error(`tip moved to ${tipAfter} during the download; rerun`);
  if (sha256(ghBytes) !== hash) {
    throw new Error(`GitHub tip asset sha256 ${sha256(ghBytes)} != ${url} ${hash}; rerun later`);
  }
  const release = await gh<{ assets?: { name: string; digest?: string }[] }>('releases/tags/tip');
  const digest = release.assets?.find((a) => a.name === WASM_FILE)?.digest?.replace(/^sha256:/, '');
  if (digest && digest !== hash) throw new Error(`GitHub asset digest ${digest} != ${hash}`);

  const sig = verifyMinisign(bytes, minisig, GHOSTTY_MINISIGN_PUBKEY);
  if (sig.file !== WASM_FILE) throw new Error(`signature is for ${sig.file}, not ${WASM_FILE}`);
  const wasm = await inspectWasm(bytes);
  if (wasm.buildInfo.optimize !== 'ReleaseSmall') {
    throw new Error(`${WASM_FILE} is ${wasm.buildInfo.optimize}, not ReleaseSmall`);
  }
  const commitInfo = await gh<{ commit?: { committer?: { date?: string } } }>(
    `commits/${commit}`,
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
    publicKey: GHOSTTY_MINISIGN_PUBKEY,
    signature: {
      keyId: sig.keyId,
      algorithm: sig.algorithm,
      trustedComment: sig.trustedComment,
      signedAt: sig.timestamp ? new Date(sig.timestamp * 1000).toISOString() : undefined,
    },
    verifiedAt: new Date().toISOString(),
    license: LICENSE_NOTE,
    wasm,
  };
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.writeFileSync(path.join(VENDOR_DIR, WASM_FILE), bytes);
  fs.writeFileSync(path.join(VENDOR_DIR, `${WASM_FILE}.minisig`), minisig);
  fs.writeFileSync(path.join(VENDOR_DIR, 'LICENSE'), license);
  fs.writeFileSync(
    path.join(VENDOR_DIR, `${WASM_FILE}.json`),
    `${JSON.stringify(sidecar, null, 2)}\n`,
  );
  console.log(`wrote ${WASM_FILE}{,.minisig,.json} and LICENSE for ${commit} to ${VENDOR_DIR}`);
  console.log('Update PROVENANCE.md if needed, then re-run the binding tests (ADR 041).');
}

async function verify(): Promise<void> {
  const { sidecar, sig } = verifyPinned(VENDOR_DIR, GHOSTTY_MINISIGN_PUBKEY);
  if (sidecar.publicKey !== GHOSTTY_MINISIGN_PUBKEY) {
    throw new Error(`sidecar key ${sidecar.publicKey} != ${GHOSTTY_MINISIGN_PUBKEY}`);
  }
  const wasm = await inspectWasm(
    new Uint8Array(fs.readFileSync(path.join(VENDOR_DIR, sidecar.file))),
  );
  console.log(
    `OK ${sidecar.file} ${sidecar.sha256}, Ghostty ${sidecar.commit}, ${wasm.buildInfo.optimize}, ` +
      `signed by ${sig.keyId} (${sig.trustedComment})`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const commitAt = args.indexOf('--commit');
  try {
    if (args.includes('--verify')) await verify();
    else if (commitAt >= 0 && args[commitAt + 1]) await update(args[commitAt + 1] as string);
    else throw new Error('usage: update-ghostty-vt.ts --commit <sha> | --verify');
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}
