/**
 * Pixel-smooth scrollback scrolling. See ADR 040 and ADR 043.
 *
 * ghostty-web draws whole rows only: its viewport is a line count, and a fractional
 * viewportY is floored when rows are picked. A trackpad reports pixel deltas, so
 * scrolling steps a whole line at a time behind a short easing animation.
 *
 * This keeps the scroll position as fractional lines. ghostty-web renders the whole
 * part as usual; the fraction becomes a pixel offset the renderer shows the viewport
 * at: its canvas also holds rows above and below the viewport, and shows the
 * viewport moved down by `fraction x cellHeight`, with the bottom of the row above
 * sliding into view. At a whole-line position there is no offset, so a resting
 * terminal renders exactly as before.
 *
 * Only the normal screen's scrollback scrolls this way. On the alternate screen, or
 * when the app tracks the mouse, the app moves its own view in whole lines.
 */
import type { Terminal } from './vendor/ghostty-web';

export interface ScrollSplit {
  /** Whole lines scrolled up from the bottom: ghostty-web's viewportY. */
  line: number;
  /** Extra offset in CSS pixels, snapped to device pixels, in `[0, cellHeight)`. */
  offset: number;
}

/** Splits a fractional scroll `position` (lines up from the bottom) into whole lines and a pixel offset. */
export function splitScroll(position: number, cellHeight: number, dpr: number): ScrollSplit {
  const line = Math.floor(position);
  const offset = Math.round((position - line) * cellHeight * dpr) / dpr;
  // Rounding can reach a full cell; that is the next whole line with no offset.
  if (offset >= cellHeight) return { line: line + 1, offset: 0 };
  return { line, offset };
}

/** Lines a wheel event scrolls toward the bottom (negative: toward the top of scrollback). */
export function wheelLines(
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  rows: number,
): number {
  if (e.deltaMode === 1) return e.deltaY; // DOM_DELTA_LINE
  if (e.deltaMode === 2) return e.deltaY * rows; // DOM_DELTA_PAGE
  return e.deltaY / cellHeight;
}

export class SmoothScroll {
  /** Lines scrolled up from the bottom; fractional between rows. */
  private position = 0;

  constructor(private readonly term: Terminal) {
    // ghostty-web moves the viewport itself on new output (to the bottom), keyboard
    // scrolling and scrollbar drags. Follow it whenever it lands on a different line.
    term.onScroll((y: number) => {
      if (y !== Math.floor(this.position)) this.jump(y);
    });
    term.onResize(() => this.jump(term.viewportY));
  }

  /** Handles a wheel event on the normal screen. Returns false to leave it to ghostty-web. */
  handleWheel(e: WheelEvent): boolean {
    if (this.term.wasmTerm?.isAlternateScreen()) return false;
    const metrics = this.term.renderer?.getMetrics();
    if (!metrics) return false;
    const max = this.term.getScrollbackLength();
    const lines = wheelLines(e, metrics.height, this.term.rows);
    this.position = Math.max(0, Math.min(max, this.position - lines));
    this.apply();
    return true;
  }

  /** New output arrived. ghostty-web only snaps to the bottom when viewportY > 0, so clear a sub-line offset here. */
  onOutput(): void {
    if (this.term.viewportY === 0 && this.position !== 0) this.jump(0);
  }

  /**
   * Re-splits the position after a fit: a DPR or font change moves the device-pixel
   * grid and the cell height the offset was snapped to.
   */
  update(): void {
    this.apply();
  }

  private jump(line: number): void {
    this.position = line;
    this.apply();
  }

  private apply(): void {
    const renderer = this.term.renderer;
    const metrics = renderer?.getMetrics();
    if (!renderer || !metrics) return;
    const { line, offset } = splitScroll(
      this.position,
      metrics.height,
      window.devicePixelRatio || 1,
    );
    // Changes ghostty-web's viewportY synchronously. Its render loop draws the rows that
    // came into view and shows the offset on the next frame.
    if (line !== this.term.viewportY) this.term.scrollToLine(line);
    renderer.setScrollOffset(offset);
  }
}
