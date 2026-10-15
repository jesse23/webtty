// Keeps the grid fitted to `#terminal` (feature, ADR 031, ADR 033, ADR 039, ADR 060): the
// fit addon and the Fitter, the first fit, and the signals that refit: ResizeObserver,
// window `resize`, the web font loading and device pixel ratio changes.

import type { ClientConfig } from '../app/client-config';
import type { ClientContext, Feature } from '../app/client-context';
import {
  DisposableStore,
  FitAddon,
  listen,
  toDisposable,
  watchDevicePixelRatio,
} from '../vendor/ghostty-web';
import { Fitter, type GridSource } from './fitter';

/** Anything that re-reads the layout after a fit. */
export interface FitListener {
  update(): void;
}

/** What the layout feature needs besides the context: the fit's listeners and the browser's. */
export interface LayoutDeps {
  /** The edge strips, placed after every fit (ADR 035). */
  edges: FitListener;
  /** Smooth scroll, which re-reads the row height after every fit (ADR 040). */
  smoothScroll: FitListener;
  ResizeObserver: typeof ResizeObserver;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  /** The grid size source; the vendored FitAddon, loaded into the terminal, by default. */
  grid?: GridSource;
}

/** The layout API others use: font zoom fits at once, everything else schedules. */
export interface LayoutFeature extends Feature {
  /** Fits now, synchronously (font zoom, ADR 033). */
  fit(): void;
  /** Fits on the next frame, coalesced with any other signal of the same frame. */
  schedule(): void;
}

/**
 * Colours the space around the canvas. The canvas paints theme.background; the container
 * shows only in the padding around it, so theme.padding (default: background) colours the
 * space set by config.padding. The sub-cell leftover at the right and bottom is not
 * coloured: EdgeExtender stretches the edge cells' own background into it (ADR 035, ADR 036).
 * Called before the terminal opens, so the first paint already has it.
 */
export function applyPaddingColor(container: HTMLElement, config: ClientConfig): void {
  const paddingColor = config.theme?.padding ?? config.theme?.background;
  if (paddingColor) {
    container.style.background = paddingColor;
  }
}

/** Loads the fit addon, fits on the next frame and refits on every layout signal. */
export function installLayout(ctx: ClientContext, deps: LayoutDeps): LayoutFeature {
  const { term, container, config, doc, win } = ctx;
  const store = new DisposableStore();
  let grid = deps.grid;
  if (!grid) {
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    grid = fitAddon;
  }
  const fitter = store.add(new Fitter(term, container, config.padding, grid, deps));
  store.add(fitter.onFitted(() => deps.edges.update()));
  store.add(fitter.onFitted(() => deps.smoothScroll.update()));
  const schedule = (): void => fitter.schedule();

  schedule();
  const observer = new deps.ResizeObserver(() => schedule());
  observer.observe(container, { box: 'border-box' });
  store.add(toDisposable(() => observer.disconnect()));
  // ResizeObserver misses monitor hot-plug and DPI changes because those resize the
  // viewport without changing the container's layout box. window resize fires reliably
  // for both, so use both observers together.
  store.add(listen(win, 'resize', schedule));

  // Chromium can still be loading config.fontFamily when the renderer measures font
  // metrics synchronously on open, so mouse-to-cell hit testing is captured against the
  // fallback font's glyph width: clicks land on the wrong cell until something resizes
  // the terminal. Firefox blocks first layout on web font load and does not hit this
  // race. Remeasure once the real font is ready; the render loop then notices the
  // canvas-vs-metrics mismatch on its next frame and repaints in full (ADR 031). The new
  // cell size also changes how many cols and rows fit and where the padding and edge
  // strips go, so fit again once the metrics have changed.
  doc.fonts.ready.then(() => {
    if (store.isDisposed) return;
    term.renderer?.remeasureFont();
    schedule();
  });

  // The renderer follows devicePixelRatio changes itself (whole ratio, ADR 039). The edge
  // strips also draw at the ratio, and the window may not resize on a move to a display
  // of different scale, so fit again on a change.
  store.add(toDisposable(watchDevicePixelRatio(win, schedule)));

  return {
    fit: () => fitter.fit(),
    schedule,
    dispose: () => store.dispose(),
  };
}
