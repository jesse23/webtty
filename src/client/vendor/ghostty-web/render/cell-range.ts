// Derived from coder/ghostty-web lib/renderer.ts and lib/link-detector.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The one cell range (object shape + util): a start and end cell, both inclusive, as the
// selection, the hovered link and LinkDetector's hit test use it (ADR 043, ADR 061).

/** A run of cells from a start cell to an end cell, both inclusive, rows in reading order. */
export interface CellRange {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

/**
 * Whether cell (`col`, `row`) is in `range`: from the start column on the first row, whole
 * middle rows, up to the end column on the last row. Called per cell while drawing, so
 * it allocates nothing.
 */
export function cellInRange(range: CellRange | null, col: number, row: number): boolean {
  if (!range || row < range.startRow || row > range.endRow) return false;
  if (range.startRow === range.endRow) return col >= range.startCol && col <= range.endCol;
  if (row === range.startRow) return col >= range.startCol; // First line: to its end
  if (row === range.endRow) return col <= range.endCol; // Last line: from its start
  return true; // Middle line: the whole line
}

/** `range` moved down by `rows` rows (up when negative); null stays null. */
export function moveRangeRows(range: CellRange | null, rows: number): CellRange | null {
  return range && { ...range, startRow: range.startRow + rows, endRow: range.endRow + rows };
}

/** Whether two ranges cover the same cells; two nulls are the same. */
export function sameRange(a: CellRange | null, b: CellRange | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.startCol === b.startCol &&
    a.startRow === b.startRow &&
    a.endCol === b.endCol &&
    a.endRow === b.endRow
  );
}
