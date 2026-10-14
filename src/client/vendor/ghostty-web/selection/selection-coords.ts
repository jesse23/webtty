// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Selection coordinates (util): buffer points that stay put while the view scrolls, their
// conversion to and from viewport rows, and the pixel, drag and canvas-edge maths of the
// selection gestures (ADR 043, ADR 061).

import type { CellRange } from '../render/cell-range';

/**
 * A selection end: a column and an ABSOLUTE row, an index into scrollback (0 to len-1)
 * followed by the screen (len to len+rows-1), so a selection persists while scrolling.
 */
export interface BufferPoint {
  col: number;
  absoluteRow: number;
}

/** A cell in viewport rows, as a pixel position maps to it. */
export interface ViewportCell {
  col: number;
  row: number;
}

/** The canvas grid a pixel position is read against. */
export interface CellGrid {
  cellWidth: number;
  cellHeight: number;
  /** How far viewport row 0 starts below the canvas top while smooth scrolling (webtty, ADR 043). */
  scrollOffset: number;
  cols: number;
  rows: number;
}

/** A canvas's client rectangle, as `getBoundingClientRect` reports it. */
export type ClientRect = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>;

/** The terminal's viewport position (lines scrolled into history), as a whole line count. */
export function wholeViewportY(rawViewportY: number): number {
  return Math.max(0, Math.floor(rawViewportY));
}

/** Viewport row to absolute buffer row. */
export function viewportRowToAbsolute(
  viewportRow: number,
  scrollbackLength: number,
  viewportY: number,
): number {
  return scrollbackLength + viewportRow - viewportY;
}

/** Absolute buffer row to viewport row; it may be outside the visible rows. */
export function absoluteRowToViewport(
  absoluteRow: number,
  scrollbackLength: number,
  viewportY: number,
): number {
  return absoluteRow - scrollbackLength + viewportY;
}

/** The cell under a canvas-relative pixel position, clamped to the terminal's size. */
export function pixelToCell(x: number, y: number, grid: CellGrid): ViewportCell {
  const col = Math.floor(x / grid.cellWidth);
  // Viewport row 0 starts the scroll offset below the canvas top (webtty, ADR 043)
  const row = Math.floor((y - grid.scrollOffset) / grid.cellHeight);
  return {
    col: Math.max(0, Math.min(col, grid.cols - 1)),
    row: Math.max(0, Math.min(row, grid.rows - 1)),
  };
}

/**
 * The range between two buffer points in viewport rows, start first: a selection dragged
 * backwards reads the same as forwards. Rows are not clamped to the viewport.
 */
export function orderedViewportRange(
  start: BufferPoint,
  end: BufferPoint,
  toViewport: (absoluteRow: number) => number,
): CellRange {
  let { col: startCol, absoluteRow: startAbsRow } = start;
  let { col: endCol, absoluteRow: endAbsRow } = end;
  if (startAbsRow > endAbsRow || (startAbsRow === endAbsRow && startCol > endCol)) {
    [startCol, endCol] = [endCol, startCol];
    [startAbsRow, endAbsRow] = [endAbsRow, startAbsRow];
  }
  return {
    startCol,
    startRow: toViewport(startAbsRow),
    endCol,
    endRow: toViewport(endAbsRow),
  };
}

/**
 * Whether a press has moved far enough to be a drag: half a cell width, so the threshold
 * scales with the font and a plain click never flashes a selection.
 */
export function pastDragThreshold(dx: number, dy: number, cellWidth: number): boolean {
  const threshold = cellWidth * 0.5;
  return dx * dx + dy * dy >= threshold * threshold;
}

/** Whether a client position is outside the rectangle (its edges count as inside). */
export function outsideRect(rect: ClientRect, clientX: number, clientY: number): boolean {
  return (
    clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom
  );
}

/** A client position clamped into the rectangle, relative to its top-left corner. */
export function clampedOffset(
  rect: ClientRect,
  clientX: number,
  clientY: number,
): { offsetX: number; offsetY: number } {
  const x = Math.max(rect.left, Math.min(clientX, rect.right));
  const y = Math.max(rect.top, Math.min(clientY, rect.bottom));
  return { offsetX: x - rect.left, offsetY: y - rect.top };
}

/** Which way a pointer is past the rectangle vertically: -1 above, 1 below, 0 level with it. */
export function verticalOverflow(rect: ClientRect, clientY: number): -1 | 0 | 1 {
  if (clientY < rect.top) return -1;
  if (clientY > rect.bottom) return 1;
  return 0;
}
