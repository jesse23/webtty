// Wires a program's OSC 52 clipboard writes to the browser clipboard (feature, ADR 052,
// ADR 060): the terminal's `onClipboardWrite` goes to a ClipboardWriter, which the user's
// input in this tab arms and each new connection disarms until the replay has passed.

import type { ClientContext, Feature } from '../../app/client-context';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import { ClipboardWriter, type TextClipboard } from './clipboard-writer';

/** What the clipboard feature needs besides the context. */
export interface ClipboardDeps {
  /** `navigator.clipboard`; undefined where the page has none (http). */
  clipboard: TextClipboard | undefined;
}

/** The clipboard API the connection uses. */
export interface ClipboardFeature extends Feature {
  /** A socket was created: the output that follows starts with the replay (ADR 052). */
  connected(): void;
}

/** Subscribes the writer to the terminal and arms it on window capture `keydown`, `mousedown`, `paste` and `drop`. */
export function installClipboard(ctx: ClientContext, deps: ClipboardDeps): ClipboardFeature {
  const { term, win } = ctx;
  const store = new DisposableStore();
  const writer = new ClipboardWriter(deps.clipboard);
  store.add(
    term.onClipboardWrite((text) => {
      void writer.write(text);
    }),
  );
  for (const type of ['keydown', 'mousedown', 'paste', 'drop'] as const) {
    store.add(listen(win, type, () => writer.userInput(), { capture: true }));
  }
  return {
    connected: () => writer.connected(),
    dispose: () => store.dispose(),
  };
}
