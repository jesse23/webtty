// Ghostty's release channels on a fake `fetch` (test fake, ADR 064): the GitHub API's tip
// tag, release and commit, the commit-addressed wasm, the `tip` assets and the licence,
// each overridable, with every request recorded in order.

import type { FetchFn } from '../release-fetch';

const API = 'https://api.github.com/repos/ghostty-org/ghostty/';
const R2 = 'https://tip.files.ghostty.org/';
const GH_TIP = 'https://github.com/ghostty-org/ghostty/releases/download/tip/';
const RAW = 'https://raw.githubusercontent.com/ghostty-org/ghostty/';

/** One release as the fake serves it. A `tips` list is served one entry per tip lookup. */
export interface FakeRelease {
  commit: string;
  wasm: Uint8Array<ArrayBuffer>;
  minisig: string;
  /** The `tip` asset's bytes; defaults to `wasm`. */
  tipWasm?: Uint8Array<ArrayBuffer>;
  license?: string;
  /** Successive answers to the tip lookup; the last one repeats. Defaults to `[commit]`. */
  tips?: string[];
  /** Serve `tip` as an annotated tag that points at the commit. */
  annotated?: boolean;
  /** The `releases/tags/tip` asset digest, if any. */
  digest?: string;
  /** The commit date, or `undefined` to answer the commits API with 500. */
  commitDate?: string;
  /** URLs answered with this status instead. */
  failing?: Record<string, number>;
}

/** A recorded request: its URL and the init the code passed. */
export interface FakeRequest {
  url: string;
  init?: RequestInit;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** A fake `fetch` serving `release`, and the requests it saw. */
export function fakeReleaseFetch(release: FakeRelease): {
  fetch: FetchFn;
  requests: FakeRequest[];
} {
  const requests: FakeRequest[] = [];
  const tips = [...(release.tips ?? [release.commit])];
  const nextTip = () => (tips.length > 1 ? (tips.shift() as string) : (tips[0] as string));
  const routes: Record<string, () => Response> = {
    [`${API}git/ref/tags/tip`]: () => {
      const sha = nextTip();
      return json({
        object: release.annotated ? { type: 'tag', sha: `tag-${sha}` } : { type: 'commit', sha },
      });
    },
    [`${API}releases/tags/tip`]: () =>
      json({
        assets: [{ name: 'other.wasm' }, { name: 'ghostty-vt-small.wasm', digest: release.digest }],
      }),
    [`${API}commits/${release.commit}`]: () =>
      release.commitDate === undefined
        ? new Response('', { status: 500 })
        : json({ commit: { committer: { date: release.commitDate } } }),
    [`${R2}${release.commit}/ghostty-vt-small.wasm`]: () => new Response(release.wasm),
    [`${GH_TIP}ghostty-vt-small.wasm`]: () => new Response(release.tipWasm ?? release.wasm),
    [`${GH_TIP}ghostty-vt-small.wasm.minisig`]: () => new Response(release.minisig),
    [`${RAW}${release.commit}/LICENSE`]: () => new Response(release.license ?? 'MIT License\n'),
  };
  const fetch: FetchFn = async (url, init) => {
    requests.push({ url, init });
    const failed = release.failing?.[url];
    if (failed) return new Response('', { status: failed });
    const tag = /git\/tags\/tag-(\w+)$/.exec(url)?.[1];
    if (tag) return json({ object: { type: 'commit', sha: tag } });
    return routes[url]?.() ?? new Response('', { status: 404 });
  };
  return { fetch, requests };
}
