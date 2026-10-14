// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal's pixel and row maths (util): pointer cells, viewport rows to buffer rows, the
// hovered link's rows in view, the mouse encoder's surface, the cursor cell and the device
// cell size. Pure functions, so the mouse, link and focus code agree on one mapping (ADR 061).

import type { MouseGeometry } from '../engine/engine-types';
import type { ILink, IBufferRange } from '../link-types';

/**
 * Mouse cursor for the terminal surface: 'pointer' over a link, otherwise the
 * platform default arrow. (webtty: upstream used the 'text' I-beam, which reads
 * as editable text over TUI menus and widgets.)
 */
export function mouseCursorFor(link: ILink | undefined): 'pointer' | 'default' {
  return link ? 'pointer' : 'default';
}

/**
 * The viewport cell under a client position: the column from the canvas's left edge, the
 * row from where viewport row 0 starts, the scroll offset below the canvas top (ADR 043).
 * The row can be outside the grid when the pointer is in the padding.
 */
export function pointerCell(
  clientX: number,
  clientY: number,
  canvasRect: { left: number; top: number },
  cell: { charWidth: number; charHeight: number; scrollOffset: number }
): { x: number; y: number } {
  return {
    x: Math.floor((clientX - canvasRect.left) / cell.charWidth),
    y: Math.floor((clientY - canvasRect.top - cell.scrollOffset) / cell.charHeight),
  };
}

/**
 * The absolute buffer row (0 = the oldest scrollback row) shown on `viewportRow`, with the
 * view `viewportY` lines back from the bottom. The view is floored to whole lines, as the
 * renderer and the selection floor it, so a smooth-scroll offset never moves a row.
 */
export function viewportRowToBufferRow(
  viewportRow: number,
  scrollbackLength: number,
  viewportY: number
): number {
  return scrollbackLength - Math.max(0, Math.floor(viewportY)) + viewportRow;
}

/** A hovered link's cells in viewport rows, as the renderer underlines them. */
export interface ViewportLinkRange {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * The part of a link (absolute buffer rows) that is in view, clamped to the rows on
 * screen, or null when none of it is. (webtty: the link's own range, OSC 8 or regex)
 */
export function linkViewportRange(
  range: IBufferRange,
  scrollbackLength: number,
  viewportY: number,
  rows: number
): ViewportLinkRange | null {
  const view = Math.max(0, Math.floor(viewportY));
  const startY = range.start.y - scrollbackLength + view;
  const endY = range.end.y - scrollbackLength + view;
  if (startY >= rows || endY < 0) return null;
  return {
    startX: range.start.x,
    startY: Math.max(0, startY),
    endX: range.end.x,
    endY: Math.min(rows - 1, endY),
  };
}

/**
 * The mouse encoder's geometry and a client position in it (ADR 049). Ghostty needs a
 * whole cell size, and webtty's CSS cell is fractional, so the units are device-pixel
 * cells: the cell is `cellPx` (the size Ghostty's size reports give, so SGR-pixels
 * positions agree with them), and CSS lengths are scaled by `cellPx` over the CSS cell.
 * The screen is the container `box`, so the padding around the grid is part of it and
 * Ghostty maps it to the nearest edge cell. The position is measured from the grid's
 * origin and then offset by the rounded padding, so rounding never moves a cell
 * boundary. (webtty)
 */
export function mouseSurface(
  clientX: number,
  clientY: number,
  grid: {
    left: number;
    top: number;
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  },
  box: { left: number; top: number; right: number; bottom: number },
  cellPx: { width: number; height: number }
): { geometry: MouseGeometry; x: number; y: number } {
  const sx = cellPx.width / grid.cellWidth;
  const sy = cellPx.height / grid.cellHeight;
  const left = Math.max(0, Math.round((grid.left - box.left) * sx));
  const top = Math.max(0, Math.round((grid.top - box.top) * sy));
  const gridRight = grid.left + grid.cols * grid.cellWidth;
  const gridBottom = grid.top + grid.rows * grid.cellHeight;
  const right = Math.max(0, Math.round((box.right - gridRight) * sx));
  const bottom = Math.max(0, Math.round((box.bottom - gridBottom) * sy));
  return {
    geometry: {
      screenWidth: left + grid.cols * cellPx.width + right,
      screenHeight: top + grid.rows * cellPx.height + bottom,
      cellWidth: cellPx.width,
      cellHeight: cellPx.height,
      paddingTop: top,
      paddingRight: right,
      paddingBottom: bottom,
      paddingLeft: left,
    },
    x: (clientX - grid.left) * sx + left,
    y: (clientY - grid.top) * sy + top,
  };
}

/**
 * A cell's size in whole device pixels, for Ghostty's size reports
 * (XTWINOPS 14/16/18/19 t, mode 2048). Computed as the kitty feature's
 * `deviceCellSize` (features/kitty/protocol/cell-geometry.ts) sizes image frames: the CSS
 * cell times `devicePixelRatio`, rounded, at least 1. (webtty, ADR 042)
 */
export function deviceCellPixels(cssCell: number, dpr: number): number {
  return Math.max(1, Math.round(cssCell * dpr));
}

/**
 * The cursor cell's top-left corner, in CSS pixels relative to the container's
 * padding box. `cursor.y` is relative to the bottom screen; when scrolled back by
 * `viewportY` lines the cursor moves down by that many rows, and it is kept on the
 * last visible row once it scrolls out of view. A pending-wrap cursor is kept on
 * the last column. (webtty: the input textarea is anchored here so the OS places
 * IME and dictation panels at the cursor.)
 */
export function cursorCellOffset(
  cursor: { x: number; y: number },
  viewportY: number,
  grid: { cols: number; rows: number },
  cell: { width: number; height: number },
  canvas: { left: number; top: number }
): { left: number; top: number } {
  const col = Math.min(Math.max(0, cursor.x), Math.max(0, grid.cols - 1));
  const row = Math.min(Math.max(0, cursor.y + Math.floor(viewportY)), Math.max(0, grid.rows - 1));
  return {
    left: canvas.left + col * cell.width,
    top: canvas.top + row * cell.height,
  };
}

/** The box styles setStylePx writes. */
export type BoxStyleProp = 'left' | 'top' | 'width' | 'height';

/** Sets a pixel style only when it changed, so a per-frame update writes nothing. (webtty) */
export function setStylePx(
  el: { readonly style: Record<BoxStyleProp, string> },
  prop: BoxStyleProp,
  value: number
): void {
  const px = `${value}px`;
  if (el.style[prop] !== px) el.style[prop] = px;
}
