// Repaints the whole canvas when the tab becomes visible again (feature, ADR 031, ADR 060).
// Chromium can evict a hidden tab's canvas backing store to reclaim GPU memory; Firefox
// does not. The render loop only repaints rows the engine marks dirty, so a cleared
// canvas could stay blank until the content changed.

import type { ClientContext, Feature } from '../app/client-context';
import { listen } from '../vendor/ghostty-web';

/** The installed repaint; nothing to call, only to dispose. */
export type RepaintOnVisibleFeature = Feature;

/** Forces a full repaint on every document `visibilitychange` to visible. */
export function installRepaintOnVisible(ctx: ClientContext): RepaintOnVisibleFeature {
  const { term, doc } = ctx;
  return listen(doc, 'visibilitychange', () => {
    if (doc.visibilityState !== 'visible') return;
    if (term.renderer && term.wasmTerm) {
      term.renderer.render(term.wasmTerm, true, term.viewportY);
    }
  });
}
