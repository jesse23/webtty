// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The cursor (objects): CursorBlink toggles its visibility on an injected interval, and
// CursorPainter draws its shape over its cell and tracks where the last frame drew it, so
// a frame repaints the old cell and never blends a translucent cursor over itself (ADR 061).

import type { Disposable } from '../lifecycle/disposable-store';
import { type RowSource, screenGraphemes } from './frame-lines';
import type {
  CellTextPainter,
  CursorStyle,
  DrawCounter,
  IntervalTimers,
  PaintSettings,
} from './renderable';
import { invalidateRow } from './row-band';

/** The blink half-period, as xterm.js uses. */
export const CURSOR_BLINK_INTERVAL_MS = 530;

/** The window's interval timer, read when the blink starts; cleared on the window that set it. */
export const windowIntervals: IntervalTimers = {
  setInterval: (run, ms) => window.setInterval(run, ms),
  clearInterval: (id) => window.clearInterval(id),
};

/**
 * Whether the cursor shows while it blinks: toggled every CURSOR_BLINK_INTERVAL_MS while
 * enabled, always shown otherwise. The render loop draws the change on its next frame.
 */
export class CursorBlink implements Disposable {
  private shown = true;
  private on = false;
  private timer?: number;

  constructor(private readonly timers: IntervalTimers = windowIntervals) {}

  /** Whether the blink is on now. */
  get visible(): boolean {
    return this.shown;
  }

  /** Whether the cursor blinks. */
  get enabled(): boolean {
    return this.on;
  }

  /** Starts or stops blinking; does nothing when it already is as asked. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.on) return;
    this.on = enabled;
    if (enabled) {
      this.timer = this.timers.setInterval(() => {
        this.shown = !this.shown;
      }, CURSOR_BLINK_INTERVAL_MS);
    } else {
      this.stop();
    }
  }

  /** Stops the timer and shows the cursor. */
  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer !== undefined) {
      this.timers.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.shown = true;
  }
}

/** Draws the cursor shape and remembers where it drew it, in canvas rows. */
export class CursorPainter {
  // Where the last frame drew the cursor: its canvas row (null: not drawn) and column (webtty)
  private drawnRow: number | null = null;
  private drawnCol = 0;
  // Cursor style or blink changed since the last frame: repaint the cursor cell so
  // the old shape does not stay under the new one (webtty)
  private shapeChanged = false;

  constructor(
    private style: CursorStyle,
    private readonly cells: CellTextPainter,
    private readonly settings: PaintSettings,
    private readonly counter: DrawCounter
  ) {}

  /** Sets the shape; a change repaints the cursor cell on the next frame. */
  setStyle(style: CursorStyle): void {
    if (style !== this.style) this.shapeChanged = true;
    this.style = style;
  }

  /** Repaints the cursor cell on the next frame (the blink was turned on or off). */
  markShapeChanged(): void {
    this.shapeChanged = true;
  }

  /** Follows the canvas content moved by `rows` rows on a copied scroll. */
  shift(rows: number): void {
    if (this.drawnRow !== null) this.drawnRow += rows;
  }

  /**
   * Invalidates the row the last frame's cursor is in unless the same cursor is drawn
   * there again (`draws` at canvas row `row`, column `col`), and returns whether it is.
   */
  invalidateDrawn(state: Uint8Array, draws: boolean, row: number, col: number): boolean {
    let same = false;
    if (this.drawnRow !== null) {
      same = draws && this.drawnRow === row && col === this.drawnCol && !this.shapeChanged;
      if (!same) invalidateRow(state, this.drawnRow);
    }
    this.shapeChanged = false;
    return same;
  }

  /** Records where this frame drew the cursor: canvas row `row` (null: not drawn), column `col`. */
  drawnAt(row: number | null, col: number): void {
    this.drawnRow = row;
    this.drawnCol = col;
  }

  /**
   * Render cursor at canvas row `y`, which shows screen row `screenRow`; the block cursor
   * draws the cell's character again in the accent colour. (webtty: the screen row)
   */
  paint(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    screenRow: number,
    rows: RowSource
  ): void {
    this.counter.draws++;
    const { metrics, theme } = this.settings;
    const cursorX = x * metrics.width;
    const cursorY = y * metrics.height;
    ctx.fillStyle = theme.cursor;
    switch (this.style) {
      case 'block': {
        ctx.fillRect(cursorX, cursorY, metrics.width, metrics.height);
        const line = rows.getLine(screenRow);
        if (line?.[x]) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(cursorX, cursorY, metrics.width, metrics.height);
          ctx.clip();
          // The grapheme of the screen row, not of the canvas row (webtty, ADR 043)
          const grapheme = screenGraphemes(rows.buffer, screenRow);
          this.cells.paintCellText(ctx, line[x], x, y, theme.cursorAccent, grapheme);
          ctx.restore();
        }
        break;
      }
      case 'underline': {
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(metrics.height * 0.15));
        const underlineY = cursorY + metrics.height - underlineHeight;
        ctx.fillRect(cursorX, underlineY, metrics.width, underlineHeight);
        break;
      }
      case 'bar': {
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(metrics.width * 0.15));
        ctx.fillRect(cursorX, cursorY, barWidth, metrics.height);
        break;
      }
    }
  }
}
