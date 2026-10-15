import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { VENDOR_DIR } from '../update-ghostty-vt';
import { fetchRelease, type ReleaseFetchDeps, releaseFetchDeps, tipCommit } from './release-fetch';
import { GHOSTTY_MINISIGN_PUBKEY, type Sidecar, WASM_FILE } from './sidecar';
import { type FakeRelease, fakeReleaseFetch } from './test-support/fake-release';
import { createMinisignSigner } from './test-support/minisign-signer';
import { tinyWasm } from './test-support/tiny-wasm';

// The committed pin, served back by the fake: fetching it must rebuild its sidecar exactly.
const SIDECAR_TEXT = fs.readFileSync(path.join(VENDOR_DIR, `${WASM_FILE}.json`), 'utf8');
const SIDECAR = JSON.parse(SIDECAR_TEXT) as Sidecar;
const WASM = new Uint8Array(fs.readFileSync(path.join(VENDOR_DIR, WASM_FILE)));
const MINISIG = fs.readFileSync(path.join(VENDOR_DIR, `${WASM_FILE}.minisig`), 'utf8');
const LICENSE = fs.readFileSync(path.join(VENDOR_DIR, 'LICENSE'), 'utf8');
const COMMIT = SIDECAR.commit;
const OTHER = 'f'.repeat(40);

const release = (overrides: Partial<FakeRelease> = {}): FakeRelease => ({
  commit: COMMIT,
  wasm: WASM,
  minisig: MINISIG,
  license: LICENSE,
  commitDate: SIDECAR.commitDate,
  ...overrides,
});

function depsFor(served: FakeRelease, overrides: Partial<ReleaseFetchDeps> = {}) {
  const fake = fakeReleaseFetch(served);
  const deps = releaseFetchDeps({
    fetch: fake.fetch,
    token: undefined,
    now: () => new Date(SIDECAR.verifiedAt),
    ...overrides,
  });
  return { deps, requests: fake.requests };
}

describe('fetchRelease', () => {
  test('rebuilds the committed sidecar from the same release', async () => {
    const { deps } = depsFor(release());
    const pin = await fetchRelease(COMMIT, deps);
    expect(`${JSON.stringify(pin.sidecar, null, 2)}\n`).toBe(SIDECAR_TEXT);
    expect(pin.bytes).toEqual(WASM);
    expect(pin.minisig).toBe(MINISIG);
    expect(new TextDecoder().decode(pin.license)).toBe(LICENSE);
  });

  test('checks tip before and after the downloads, then the release and the commit', async () => {
    const { deps, requests } = depsFor(release());
    await fetchRelease(COMMIT, deps);
    const api = 'https://api.github.com/repos/ghostty-org/ghostty/';
    const tip = 'https://github.com/ghostty-org/ghostty/releases/download/tip/';
    expect(requests.map((r) => r.url)).toEqual([
      `${api}git/ref/tags/tip`,
      `https://tip.files.ghostty.org/${COMMIT}/${WASM_FILE}`,
      `${tip}${WASM_FILE}`,
      `${tip}${WASM_FILE}.minisig`,
      `https://raw.githubusercontent.com/ghostty-org/ghostty/${COMMIT}/LICENSE`,
      `${api}git/ref/tags/tip`,
      `${api}releases/tags/tip`,
      `${api}commits/${COMMIT}`,
    ]);
    expect(requests[1]?.init).toEqual({ redirect: 'follow' });
    expect(requests[0]?.init).toEqual({ headers: { accept: 'application/vnd.github+json' } });
  });

  test('sends the GitHub token to the API only', async () => {
    const { deps, requests } = depsFor(release(), { token: 'secret' });
    await fetchRelease(COMMIT, deps);
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
    expect(requests[1]?.init).toEqual({ redirect: 'follow' });
  });

  test('accepts a matching asset digest and leaves out a commit date it cannot get', async () => {
    const { deps } = depsFor(
      release({ digest: `sha256:${SIDECAR.sha256}`, commitDate: undefined }),
    );
    const pin = await fetchRelease(COMMIT, deps);
    expect(pin.sidecar.commitDate).toBeUndefined();
  });

  test.each<[string, string, Partial<FakeRelease>, string]>([
    ['a short sha', 'abc', {}, '--commit needs a full 40-character sha'],
    [
      'a commit that is not tip',
      COMMIT,
      { tips: [OTHER] },
      `${COMMIT} is not the current tip (${OTHER})`,
    ],
    [
      'tip moving during the download',
      COMMIT,
      { tips: [COMMIT, OTHER] },
      `tip moved to ${OTHER} during the download; rerun`,
    ],
    [
      'a GitHub asset with other bytes',
      COMMIT,
      { tipWasm: new Uint8Array([1]) },
      'GitHub tip asset sha256',
    ],
    [
      'a GitHub asset digest that differs',
      COMMIT,
      { digest: 'sha256:beef' },
      `GitHub asset digest beef != ${SIDECAR.sha256}`,
    ],
    [
      'a failed download',
      COMMIT,
      { failing: { [`https://tip.files.ghostty.org/${COMMIT}/${WASM_FILE}`]: 404 } },
      `GET https://tip.files.ghostty.org/${COMMIT}/${WASM_FILE}: 404`,
    ],
    [
      'a failed API call',
      COMMIT,
      { failing: { 'https://api.github.com/repos/ghostty-org/ghostty/git/ref/tags/tip': 403 } },
      'GitHub API git/ref/tags/tip: 403',
    ],
    [
      'a signature by another key',
      COMMIT,
      { minisig: createMinisignSigner().sign(WASM, 'file:ghostty-vt-small.wasm') },
      'minisign: signed by key',
    ],
  ])('rejects %s', async (_name, commit, overrides, message) => {
    const { deps } = depsFor(release(overrides));
    await expect(fetchRelease(commit, deps)).rejects.toThrow(message);
  });

  test('rejects a signature for another file name', async () => {
    const signer = createMinisignSigner();
    const { deps } = depsFor(release({ minisig: signer.sign(WASM, 'file:other.wasm') }), {
      publicKey: signer.publicKey,
    });
    await expect(fetchRelease(COMMIT, deps)).rejects.toThrow(
      `signature is for other.wasm, not ${WASM_FILE}`,
    );
  });

  test('rejects a build that is not ReleaseSmall', async () => {
    const signer = createMinisignSigner();
    const wasm = tinyWasm(0);
    const { deps } = depsFor(release({ wasm, minisig: signer.sign(wasm, `file:${WASM_FILE}`) }), {
      publicKey: signer.publicKey,
    });
    await expect(fetchRelease(COMMIT, deps)).rejects.toThrow(
      `${WASM_FILE} is Debug, not ReleaseSmall`,
    );
  });
});

describe('tipCommit', () => {
  test('reads a lightweight tag', async () => {
    expect(await tipCommit(depsFor(release()).deps)).toBe(COMMIT);
  });

  test('follows an annotated tag to its commit', async () => {
    const { deps, requests } = depsFor(release({ annotated: true }));
    expect(await tipCommit(deps)).toBe(COMMIT);
    expect(requests.map((r) => r.url.split('/repos/ghostty-org/ghostty/')[1])).toEqual([
      'git/ref/tags/tip',
      `git/tags/tag-${COMMIT}`,
    ]);
  });
});

describe('releaseFetchDeps', () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("defaults to the network, Ghostty's key and the current time", () => {
    const deps = releaseFetchDeps();
    expect(deps.publicKey).toBe(GHOSTTY_MINISIGN_PUBKEY);
    expect(typeof deps.fetch).toBe('function');
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(5000);
  });

  test('takes the token from GITHUB_TOKEN, then GH_TOKEN', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'gh';
    expect(releaseFetchDeps().token).toBe('gh');
    process.env.GITHUB_TOKEN = 'github';
    expect(releaseFetchDeps().token).toBe('github');
  });

  test('the default fetch is the global fetch', async () => {
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      const res = await releaseFetchDeps().fetch('https://example.test/', { redirect: 'follow' });
      expect(await res.text()).toBe('ok');
      expect(spy).toHaveBeenCalledWith('https://example.test/', { redirect: 'follow' });
    } finally {
      spy.mockRestore();
    }
  });
});
