// What every client feature may use, and the shape an installed feature returns (types,
// ADR 060). Handles of other parts (the connection, the fitter, the find bar) are not
// here: the root passes them to the installers that need them, as `deps`.

import type { Disposable, Terminal } from '../vendor/ghostty-web';
import type { ClientWindow } from './browser-env';
import type { ClientConfig } from './client-config';

export type { Disposable } from '../vendor/ghostty-web';

/** The objects the root builds once and every feature installer receives. */
export interface ClientContext {
  term: Terminal;
  /** `#terminal`, the element the terminal is opened in. */
  container: HTMLElement;
  config: ClientConfig;
  /** The config theme in ghostty-web's names (ADR 036). */
  terminalTheme: Record<string, string>;
  /** Whether Ghostty's macOS key defaults apply (ADR 054). */
  mac: boolean;
  doc: Document;
  win: ClientWindow;
}

/** An installed feature: its `dispose()` removes everything it added and is idempotent. */
export type Feature = Disposable;

/** A feature installer, `install<Name>(ctx, deps)`, returning its feature and any API others need. */
export type FeatureInstaller<Deps, F extends Feature = Feature> = (
  ctx: ClientContext,
  deps: Deps,
) => F;
