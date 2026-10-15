// webtty (ADR 043, ADR 061), not from upstream.
// The row repainter (object): repaints runs of canvas rows exactly as a full redraw leaves
// them, through a small scratch canvas it owns, and moves the canvas content on a copied
// scroll. It draws rows through a RowPainter, on the context it passes in.

import type { DrawCounter, PaintSettings, RowContent, RowPainter } from './renderable';
import { ROW_CUT, ROW_INVALID, ROW_JOINED, repaintRunEnd, wantedRowState } from './row-band';

/**
 * Rows a partial repaint draws on the scratch canvas at once, besides the row below: a
 * longer run is repainted in chunks of this many rows, so the scratch canvas stays a few
 * rows high instead of growing to the canvas' size. (webtty, ADR 043)
 */
export const REPAINT_CHUNK_ROWS = 8;

/** Reads what canvas row `k` shows, for the frame being drawn. */
export type RowAt = (k: number) => RowContent;

/**
 * Repaints canvas rows and copies scrolled ones, on `canvas` through `ctx`; partial
 * repaints are drawn on `scratch` first. The scratch canvas is created by the renderer, so
 * the order canvases are created in stays the renderer's.
 */
export class RowRepainter {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly scratch: HTMLCanvasElement,
    private readonly rows: RowPainter,
    private readonly settings: PaintSettings,
    private readonly counter: DrawCounter
  ) {
    this.freeScratch();
  }

  /**
   * Repaints the rows in view, `first` to `last` with viewport row 0 at canvas row `top`,
   * that are not as a full redraw of the viewport leaves them: the last row and the row
   * above the viewport (`first` is `top - 1` while it shows) have nothing drawn into them
   * from below. Returns which canvas rows were repainted. (webtty, ADR 043)
   */
  repaintView(
    state: Uint8Array,
    first: number,
    top: number,
    last: number,
    cols: number,
    rowAt: RowAt
  ): Uint8Array {
    const repainted = new Uint8Array(state.length);
    for (let k = first; k <= last; k++) {
      if (state[k] === wantedRowState(k, top, last)) continue;
      const end = repaintRunEnd(state, k, top, last);
      this.repaint(state, k, end, wantedRowState(end, top, last) === ROW_CUT, cols, rowAt);
      repainted.fill(1, k, end + 1);
      k = end;
    }
    return repainted;
  }

  /**
   * Repaints canvas rows `first` to `last` exactly as a full redraw leaves them, and sets
   * their states in `state`. A full redraw draws every row in order, each clearing its own
   * cell area first, so a row's pixels are its own cells plus whatever the next line draws
   * over it (tall glyphs, combining marks); what the row above overflows into it is
   * cleared. So the rows are drawn in order, plus the next line unless the last row is
   * `cut`: drawn with its own cells only, as the last row of a full redraw is.
   *
   * The rows are drawn on the scratch canvas and copied into the canvas, unless they are
   * cut and the rows they draw into around them are invalid anyway. A run that is not cut
   * ends before a row that is kept. Drawing them clipped to the rows is
   * not the same: Chrome skips a glyph whose box is outside the clip, so a combining mark
   * of the next line loses the antialiased edge it draws on the last pixel line.
   * A long run is drawn on the scratch canvas in chunks of `REPAINT_CHUNK_ROWS` rows, each
   * with the next line, which leaves every row as the whole run drawn at once would: a
   * row's pixels depend only on its own line and the next.
   * (webtty, ADR 043)
   */
  repaint(
    state: Uint8Array,
    first: number,
    last: number,
    cut: boolean,
    cols: number,
    rowAt: RowAt
  ): void {
    this.counter.draws++;
    const total = state.length;
    const free = (k: number) => k < 0 || k >= total || state[k] === ROW_INVALID;
    // Drawn on the canvas, the row above gets the first row's overflow and the row below
    // the last one's
    if (cut && free(first - 1) && free(last + 1)) {
      for (let k = first; k <= last; k++) this.rows.paintRow(this.ctx, k, cols, rowAt(k));
    } else {
      for (let from = first; from <= last; from += REPAINT_CHUNK_ROWS) {
        const to = Math.min(from + REPAINT_CHUNK_ROWS - 1, last);
        this.repaintChunk(from, to, cut && to === last, cols, rowAt);
      }
    }
    for (let k = first; k <= last; k++) state[k] = ROW_JOINED;
    state[last] = cut ? ROW_CUT : ROW_JOINED;
  }

  /**
   * Moves the canvas content down by `rows` rows (up when negative) with one drawImage of
   * the canvas onto itself, in device pixels. The 'copy' operator replaces pixels instead
   * of blending onto them (a translucent background would darken) and clears the rest of
   * the canvas: the rows that came in, which are invalid. (webtty, ADR 043)
   */
  shiftRows(rows: number): void {
    this.counter.draws++;
    const { width, height } = this.canvas;
    const dy = rows * this.settings.metrics.height * this.settings.devicePixelRatio;
    const kept = height - Math.abs(dy);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, Math.max(0, -dy), width, kept, 0, Math.max(0, dy), width, kept);
    ctx.restore();
  }

  /** Frees the scratch canvas' backing store; the next partial repaint sizes it. */
  freeScratch(): void {
    this.scratch.width = 0;
    this.scratch.height = 0;
  }

  /**
   * Draws canvas rows `first` to `last`, plus the next line unless `cut`, on the scratch
   * canvas and copies rows `first` to `last` into the canvas. (webtty, ADR 043)
   */
  private repaintChunk(first: number, last: number, cut: boolean, cols: number, rowAt: RowAt): void {
    const end = cut ? last : last + 1;
    const scratch = this.scratchContext(first, end - first + 1);
    for (let k = first; k <= end; k++) this.rows.paintRow(scratch, k, cols, rowAt(k));
    // Replace the rows' pixels in device pixels: cleared first, the copy is not blended
    // over them, so a translucent background does not darken
    const own = this.ctx;
    const rowHeight = this.settings.metrics.height * this.settings.devicePixelRatio;
    const width = this.canvas.width;
    const top = first * rowHeight;
    const height = (last - first + 1) * rowHeight;
    own.save();
    own.setTransform(1, 0, 0, 1, 0, 0);
    own.globalAlpha = 1;
    own.globalCompositeOperation = 'source-over';
    own.imageSmoothingEnabled = false;
    own.clearRect(0, top, width, height);
    own.drawImage(this.scratch, 0, 0, width, height, 0, top, width, height);
    own.restore();
  }

  /**
   * The scratch canvas' context, as wide as the canvas and at least `count` rows high,
   * scaled like the canvas and moved up so canvas row `first` is drawn at its top.
   * (webtty, ADR 043)
   */
  private scratchContext(first: number, count: number): CanvasRenderingContext2D {
    const dpr = this.settings.devicePixelRatio;
    const rowHeight = this.settings.metrics.height * dpr;
    const width = this.canvas.width;
    const height = count * rowHeight;
    if (this.scratch.width !== width) this.scratch.width = width;
    if (this.scratch.height < height) this.scratch.height = height;
    const ctx = this.scratch.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    // Set every time: resizing, or a lost context, resets the context state
    ctx.setTransform(dpr, 0, 0, dpr, 0, -first * rowHeight);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    return ctx;
  }
}
