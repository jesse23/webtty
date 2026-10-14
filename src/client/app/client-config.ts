// The config the client reads, and the one call that fetches it from the server
// (service + types, ADR 009, ADR 060). The keys are src/config's own types, imported as
// types only, so the bundle carries no Node code.

import type { Config } from '../../config';

export type { KeyboardBinding, Theme } from '../../config';

/**
 * The config keys the client reads from `/api/config`. Replaced by the src/config
 * ClientConfig at C-F, once the server branch has merged.
 */
export type ClientConfig = Pick<
  Config,
  | 'cols'
  | 'rows'
  | 'fontSize'
  | 'fontFamily'
  | 'cursorStyle'
  | 'cursorStyleBlink'
  | 'scrollbackLines'
  | 'theme'
  | 'copyOnSelect'
  | 'rightClickBehavior'
  | 'clipboardWrite'
  | 'bellTitle'
  | 'desktopNotifications'
  | 'mouseScrollSpeed'
  | 'padding'
  | 'keyboardBindings'
>;

/** The part of `fetch` the loader uses, so a test passes a fake. */
export type ConfigFetch = (url: string) => Promise<Pick<Response, 'json'>>;

/**
 * The config as the server resolves it, fetched on every page load so an edited config
 * file takes effect on the next reload (ADR 009). The body is trusted as is, as before.
 */
export async function loadClientConfig(fetch: ConfigFetch): Promise<ClientConfig> {
  return fetch('/api/config').then((r) => r.json());
}
