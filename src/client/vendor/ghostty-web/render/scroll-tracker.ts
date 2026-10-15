// webtty (ADR 043, ADR 061), not from upstream.
// The scroll tracker (object): compares a frame with the last one to tell which screen
// rows the engine changed, whether the lines moved under the canvas rows, and whether
// that forces the frame to repaint every row.

import type { RowSource } from './frame-lines';

/** What changed since the last frame. */
export interface FrameMoves {
  /** The rows the engine changed, in screen rows; empty when every row is repainted anyway. */
  dirtyRows: number[];
  /** New scrollback or a changed row: every line may have moved (the screen scrolled). */
  linesMoved: boolean;
  /** Every row must be repainted. */
  repaintAll: boolean;
}

/** Remembers the last frame's viewportY and scrollback length. */
export class ScrollTracker {
  private lastViewportY = 0;
  private lastScrollbackLength = 0;

  /**
   * Compares this frame, at `viewportY` (whole line `view`), with the last one. A
   * fractional viewportY (ghostty-web's own eased scroll) repaints every row, and so do
   * lines that moved on a move, or under a view scrolled back: new scrollback, or every
   * screen row changed. Otherwise the screen's dirty rows are repainted as dirty, at the
   * bottom or scrolled back (a redraw in place, which keeps the view on its text, ADR 066),
   * and the rows out of view when they come into view. `forceAll` skips the dirty-row scan.
   */
  track(source: RowSource, viewportY: number, view: number, forceAll: boolean): FrameMoves {
    const dirtyRows: number[] = [];
    if (!forceAll) {
      for (let y = 0; y < source.rows; y++) {
        if (source.buffer.isRowDirty(y)) dirtyRows.push(y);
      }
    }
    const moved = viewportY !== this.lastViewportY;
    if (moved && !(Number.isInteger(viewportY) && Number.isInteger(this.lastViewportY))) {
      forceAll = true;
    }
    this.lastViewportY = viewportY;
    const grew = source.scrollbackLength !== this.lastScrollbackLength;
    const linesMoved = grew || dirtyRows.length > 0;
    const shifted = grew || dirtyRows.length >= source.rows;
    if (linesMoved && (moved || (view > 0 && shifted))) forceAll = true;
    this.lastScrollbackLength = source.scrollbackLength;
    return { dirtyRows, linesMoved, repaintAll: forceAll };
  }
}
