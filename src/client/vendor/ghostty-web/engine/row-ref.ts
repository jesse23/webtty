// webtty (ADR 042, ADR 061), not from upstream.
// A decoded row and the pure helpers on it (util): the shape the render state and the
// scrollback pages hand out, blank cells, and the copies and grapheme strings read from it.

import type { GhosttyCell } from './cell-types';

/** A decoded row: JS-owned cells and the strings of its multi-codepoint graphemes. */
export interface RowRef {
  cells: GhosttyCell[];
  /** Index of the row's first cell in `cells`. */
  base: number;
  /** Column → grapheme string, for cells holding more than one codepoint. */
  graphemes: Map<number, string> | null;
}

/** A fresh empty cell, the value every decoded cell starts from. */
export function blankCell(): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

/** A row of `cols` fresh empty cells. */
export function blankCells(cols: number): GhosttyCell[] {
  const cells: GhosttyCell[] = [];
  for (let x = 0; x < cols; x++) cells.push(blankCell());
  return cells;
}

/** Writes 0xRRGGBB foreground and background colours into a cell's channels. */
export function setRgb(cell: GhosttyCell, fg: number, bg: number): void {
  cell.fg_r = (fg >>> 16) & 0xff;
  cell.fg_g = (fg >>> 8) & 0xff;
  cell.fg_b = fg & 0xff;
  cell.bg_r = (bg >>> 16) & 0xff;
  cell.bg_g = (bg >>> 8) & 0xff;
  cell.bg_b = bg & 0xff;
}

/** A copy of the row's first `cols` cells, so a caller cannot change the decoded copy. */
export function copyRow(ref: RowRef, cols: number): GhosttyCell[] {
  const out: GhosttyCell[] = new Array(cols);
  for (let x = 0; x < cols; x++) out[x] = { ...ref.cells[ref.base + x] };
  return out;
}

/** The text of one cell: its grapheme string, its codepoint, or a space when empty. */
export function graphemeOf(ref: RowRef, col: number): string {
  const g = ref.graphemes?.get(col);
  if (g !== undefined) return g;
  const cp = ref.cells[ref.base + col].codepoint;
  return cp ? String.fromCodePoint(cp) : ' ';
}
