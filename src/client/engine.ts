/**
 * Which terminal engine a tab runs (ADR 042).
 *
 * The default is compiled into `client-browser.js`; `?engine=coder` or
 * `?engine=official` in the page URL overrides it for that tab. Any other value
 * uses the default. Nothing is stored, so a reload keeps whatever the URL says.
 */

import type { EngineName } from './vendor/ghostty-web';

/** The engine a tab runs without `?engine`. Flips to `official` after ADR 042's matrix. */
export const DEFAULT_ENGINE: EngineName = 'coder';

/** The engine for a page whose URL query string is `search` (e.g. `?engine=official`). */
export function selectEngine(search: string): EngineName {
  const engine = new URLSearchParams(search).get('engine');
  return engine === 'coder' || engine === 'official' ? engine : DEFAULT_ENGINE;
}

/** Where the server serves each engine's wasm; the client fetches only the selected one. */
export function engineWasmPath(engine: EngineName): string {
  return engine === 'official' ? '/ghostty-vt-small.wasm' : '/ghostty-vt.wasm';
}
