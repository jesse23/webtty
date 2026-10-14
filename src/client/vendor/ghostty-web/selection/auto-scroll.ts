// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Drag auto-scroll (object): while a selection drag is near or past the canvas's top or
// bottom edge, an interval scrolls the terminal and lets the drag extend the selection
// (ADR 061).

import type { Disposable } from '../lifecycle/disposable-store';
import type { BufferPoint } from './selection-coords';

/** How close to the canvas's top or bottom edge, in CSS pixels, a drag starts scrolling. */
export const AUTO_SCROLL_EDGE_PX = 30;
/** Lines scrolled per step. */
export const AUTO_SCROLL_LINES = 3;
/** Time between scroll steps, in ms. */
export const AUTO_SCROLL_INTERVAL_MS = 50;

/** -1 scrolls up into history, 1 down to newer rows, the sign `scrollLines` takes. */
export type ScrollDirection = -1 | 1;

/** The interval timers the auto-scroll runs on, injected so tests drive them by hand. */
export interface AutoScrollTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

/** The global timers, read when called, as upstream used them. */
const globalTimers: AutoScrollTimers = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (id) => clearInterval(id as number),
};

/** Which way a drag at `offsetY` on a canvas `height` pixels high scrolls, or 0 for none. */
export function edgeDirection(offsetY: number, height: number): ScrollDirection | 0 {
  if (offsetY < AUTO_SCROLL_EDGE_PX) return -1;
  if (offsetY > height - AUTO_SCROLL_EDGE_PX) return 1;
  return 0;
}

/**
 * Where a scroll step moves the selection's moving end: to the top-left visible cell when
 * scrolling up, the bottom-right one when scrolling down, only if that extends the
 * selection; null leaves it where it is.
 */
export function extendedEnd(
  end: BufferPoint,
  direction: ScrollDirection,
  view: { top: number; bottom: number; lastCol: number },
): BufferPoint | null {
  if (direction < 0) return view.top < end.absoluteRow ? { col: 0, absoluteRow: view.top } : null;
  return view.bottom > end.absoluteRow ? { col: view.lastCol, absoluteRow: view.bottom } : null;
}

/**
 * Runs `step` every AUTO_SCROLL_INTERVAL_MS in one direction until stopped. Starting in
 * the direction it already scrolls keeps the running interval; another direction restarts it.
 */
export class AutoScroll implements Disposable {
  private timer: unknown = null;
  private scrolling: ScrollDirection | 0 = 0;

  constructor(
    private readonly step: (direction: ScrollDirection) => void,
    private readonly timers: AutoScrollTimers = globalTimers,
  ) {}

  /** The direction it scrolls in, or 0 when stopped. */
  get direction(): ScrollDirection | 0 {
    return this.scrolling;
  }

  /** Starts scrolling in `direction`. */
  start(direction: ScrollDirection): void {
    if (this.timer !== null && this.scrolling === direction) return;
    this.stop();
    this.scrolling = direction;
    this.timer = this.timers.setInterval(() => this.step(direction), AUTO_SCROLL_INTERVAL_MS);
  }

  /** Scrolls while a drag at `offsetY` is near the canvas's top or bottom edge, else stops. */
  followEdge(offsetY: number, height: number): void {
    const direction = edgeDirection(offsetY, height);
    if (direction === 0) this.stop();
    else this.start(direction);
  }

  /** Stops scrolling; stopping when stopped does nothing. */
  stop(): void {
    if (this.timer !== null) {
      this.timers.clearInterval(this.timer);
      this.timer = null;
    }
    this.scrolling = 0;
  }

  dispose(): void {
    this.stop();
  }
}
