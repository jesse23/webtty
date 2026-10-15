import { describe, expect, test } from 'bun:test';
import {
  type CellRange,
  cellInRange,
  moveRangeRows,
  sameRange,
} from '../../ghostty-web/render/cell-range';

// The one inclusive cell range: hit test, move and compare.

const range = (startCol: number, startRow: number, endCol: number, endRow: number): CellRange => ({
  startCol,
  startRow,
  endCol,
  endRow,
});

describe('cellInRange', () => {
  const oneRow = range(2, 1, 5, 1);
  const rows = range(6, 1, 3, 3);
  test.each([
    ['no range', null, 0, 0, false],
    ['one row: before the start', oneRow, 1, 1, false],
    ['one row: the start', oneRow, 2, 1, true],
    ['one row: the end', oneRow, 5, 1, true],
    ['one row: past the end', oneRow, 6, 1, false],
    ['one row: another row', oneRow, 3, 2, false],
    ['rows: above', rows, 7, 0, false],
    ['rows: first row before the start', rows, 5, 1, false],
    ['rows: first row from the start', rows, 6, 1, true],
    ['rows: first row to its end', rows, 79, 1, true],
    ['rows: a middle row, first column', rows, 0, 2, true],
    ['rows: a middle row, last column', rows, 79, 2, true],
    ['rows: last row from its start', rows, 0, 3, true],
    ['rows: last row, the end', rows, 3, 3, true],
    ['rows: last row past the end', rows, 4, 3, false],
    ['rows: below', rows, 0, 4, false],
  ] as const)('%s', (_name, r, col, row, inside) => {
    expect(cellInRange(r, col, row)).toBe(inside);
  });
});

describe('moveRangeRows', () => {
  test.each([
    [range(1, 2, 3, 4), 5, range(1, 7, 3, 9)],
    [range(1, 2, 3, 4), -2, range(1, 0, 3, 2)],
    [range(1, 2, 3, 4), 0, range(1, 2, 3, 4)],
    [null, 3, null],
  ])('%p moved %p rows', (r, rows, moved) => {
    expect(moveRangeRows(r, rows)).toEqual(moved);
  });

  test('returns a new range, leaving the old one', () => {
    const r = range(1, 2, 3, 4);
    moveRangeRows(r, 1);
    expect(r).toEqual(range(1, 2, 3, 4));
  });
});

describe('sameRange', () => {
  test.each([
    ['two nulls', null, null, true],
    ['a range and null', range(0, 0, 0, 0), null, false],
    ['null and a range', null, range(0, 0, 0, 0), false],
    ['equal ranges', range(1, 2, 3, 4), range(1, 2, 3, 4), true],
    ['another start column', range(1, 2, 3, 4), range(0, 2, 3, 4), false],
    ['another start row', range(1, 2, 3, 4), range(1, 1, 3, 4), false],
    ['another end column', range(1, 2, 3, 4), range(1, 2, 2, 4), false],
    ['another end row', range(1, 2, 3, 4), range(1, 2, 3, 5), false],
  ])('%s', (_name, a, b, same) => {
    expect(sameRange(a, b)).toBe(same);
  });
});
