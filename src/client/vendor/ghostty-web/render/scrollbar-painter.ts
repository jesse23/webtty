// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The scrollbar painter (object): paints the track and thumb over the right edge of the
// rows in view, with the geometry the terminal's hit test shares, and invalidates the rows
// it no longer covers so none keeps an old thumb (ADR 043, ADR 061).

import type { DrawCounter, PaintSettings } from './renderable';
import { invalidateRow } from './row-band';
import {
  SCROLLBAR_PADDING,
  SCROLLBAR_WIDTH,
  scrollbarThumbHeight,
  scrollbarThumbY,
  scrollbarTrackHeight,
  scrollbarX,
} from './scrollbar-geometry';

/** Paints the scrollbar on the canvas and remembers which canvas rows it is over. */
export class ScrollbarPainter {
  // The first canvas row the last frame painted the scrollbar over (null: none)
  private drawnRow: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly settings: PaintSettings,
    private readonly counter: DrawCounter
  ) {}

  /** Follows the canvas content moved by `rows` rows on a copied scroll. */
  shift(rows: number): void {
    if (this.drawnRow !== null) this.drawnRow += rows;
  }

  /**
   * Invalidates the `rows` rows the last frame's scrollbar covered that this frame's,
   * painted from canvas row `row` (null: not painted), does not, and records `row`.
   */
  moveTo(state: Uint8Array, row: number | null, rows: number): void {
    if (this.drawnRow !== null && this.drawnRow !== row) {
      for (let k = this.drawnRow; k < this.drawnRow + rows; k++) {
        if (row === null || k < row || k >= row + rows) invalidateRow(state, k);
      }
    }
    this.drawnRow = row;
  }

  /**
   * Render scrollbar
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   * @param row The canvas row of viewport row 0: it is painted over the rows in view (webtty)
   */
  paint(
    ctx: CanvasRenderingContext2D,
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number,
    row: number
  ): void {
    this.counter.draws++;
    const { metrics, theme, devicePixelRatio } = this.settings;
    const top = row * metrics.height;
    const canvasHeight = visibleRows * metrics.height;
    const canvasWidth = this.canvas.width / devicePixelRatio;

    // Scrollbar dimensions (shared with the terminal's hit test)
    const x = scrollbarX(canvasWidth);
    const trackHeight = scrollbarTrackHeight(canvasHeight);

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(x - 2, top, SCROLLBAR_WIDTH + 6, canvasHeight);
    ctx.fillStyle = theme.background;
    ctx.fillRect(x - 2, top, SCROLLBAR_WIDTH + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position (0 = at bottom, scrollbackLength = at top)
    const thumbHeight = scrollbarThumbHeight(visibleRows, scrollbackLength, trackHeight);
    const thumbY = scrollbarThumbY(viewportY, scrollbackLength, trackHeight, thumbHeight);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(x, top + SCROLLBAR_PADDING, SCROLLBAR_WIDTH, trackHeight);

    // Draw scrollbar thumb with opacity
    const baseOpacity = viewportY > 0 ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(x, top + thumbY, SCROLLBAR_WIDTH, thumbHeight);
  }
}
