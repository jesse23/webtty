// Font zoom on Ctrl/Cmd with +, - or 0 (feature, ADR 033, ADR 060). A window capture
// listener, so it works whatever has focus; preventDefault stops the browser's page zoom
// and stopPropagation keeps the key from reaching the terminal as input.

import type { ClientContext, Feature } from '../../app/client-context';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import { clampFontSize, zoomedFontSize, zoomStepFor } from './font-zoom';

/** What font zoom needs besides the context. */
export interface FontZoomDeps {
  /** Fits the grid at once, so the new size never paints at the old grid (ADR 033). */
  fit(): void;
}

/** The installed font zoom; nothing to call, only to dispose. */
export type FontZoomFeature = Feature;

/** Adds the window capture `keydown` listener that zooms from the configured font size. */
export function installFontZoom(ctx: ClientContext, deps: FontZoomDeps): FontZoomFeature {
  const { term, config, win } = ctx;
  const store = new DisposableStore();
  let fontSize = clampFontSize(config.fontSize);
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = zoomStepFor(e);
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    fontSize = zoomedFontSize(step, fontSize, config.fontSize);
    term.options.fontSize = fontSize;
    deps.fit();
  };
  // ClientWindow is a plain listener target, so its events arrive untyped.
  store.add(listen(win, 'keydown', (e) => onKeyDown(e as KeyboardEvent), { capture: true }));
  return { dispose: () => store.dispose() };
}
