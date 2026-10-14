// Wires the paste gestures to the paste service (feature, ADR 014, ADR 051, ADR 060): the
// right click set to paste, and the browser's `paste` event on the terminal. The paste
// keys go through the key dispatcher, which calls the same service.

import type { ClientContext, Feature } from '../../app/client-context';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import type { PasteService } from './paste-service';

/** What the paste feature needs besides the context. */
export interface PasteDeps {
  /** Built by the root before the key dispatcher, which pastes through it too. */
  paste: PasteService;
}

/** The installed paste gestures; nothing to call, only to dispose. */
export type PasteFeature = Feature;

/** Subscribes to `onPasteRequest`, then adds the container capture `paste` listener. */
export function installPaste(ctx: ClientContext, deps: PasteDeps): PasteFeature {
  const { term, container } = ctx;
  const { paste } = deps;
  const store = new DisposableStore();
  // rightClickBehavior "paste" (ADR 051)
  store.add(
    term.onPasteRequest(() => {
      paste.pasteFromClipboard();
    }),
  );
  store.add(
    listen(
      container,
      'paste',
      (e: ClipboardEvent) => {
        const cd = e.clipboardData;
        if (!cd) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        paste.paste(cd.getData('text/plain'));
      },
      { capture: true },
    ),
  );
  return { dispose: () => store.dispose() };
}
