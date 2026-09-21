import { describe, expect, test } from 'bun:test';
import { computeGrid, computeInsets, MIN_COLS, MIN_ROWS } from './fit';

describe('computeGrid', () => {
  test('uses the whole container width, with no scrollbar reserve', () => {
    // 800px / 10px = exactly 80 columns; a 15px reserve would give 78.
    expect(computeGrid(800, 400, 10, 20)).toEqual({ cols: 80, rows: 20 });
  });

  test('floors to whole cells', () => {
    expect(computeGrid(809, 419, 10, 20)).toEqual({ cols: 80, rows: 20 });
    expect(computeGrid(799, 399, 10, 20)).toEqual({ cols: 79, rows: 19 });
  });

  test('handles fractional cell sizes', () => {
    expect(computeGrid(1000, 500, 8.4, 17)).toEqual({ cols: 119, rows: 29 });
  });

  test('reserves padding on each side', () => {
    // 800px - 2 x 10px = 780px -> 78 cols; 400px - 2 x 10px = 380px -> 19 rows.
    expect(computeGrid(800, 400, 10, 20, 10)).toEqual({ cols: 78, rows: 19 });
  });

  test('treats a negative padding as none', () => {
    expect(computeGrid(800, 400, 10, 20, -5)).toEqual({ cols: 80, rows: 20 });
  });

  test('never goes below the minimum grid', () => {
    expect(computeGrid(5, 5, 10, 20)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
    expect(computeGrid(100, 100, 10, 20, 60)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });

  test('returns null when the size or the cell size is unknown', () => {
    expect(computeGrid(0, 400, 10, 20)).toBeNull();
    expect(computeGrid(800, 0, 10, 20)).toBeNull();
    expect(computeGrid(800, 400, 0, 20)).toBeNull();
    expect(computeGrid(800, 400, 10, 0)).toBeNull();
  });
});

describe('computeInsets', () => {
  test('with no padding, top and left are flush and the leftover goes right and bottom', () => {
    expect(computeInsets(9, 13, 0)).toEqual({ left: 0, right: 9, top: 0, bottom: 13 });
  });

  test('top and left are exactly the padding; right and bottom add the leftover', () => {
    // hGap 29 = 2 x 10 padding + 9 leftover; vGap 33 = 2 x 10 padding + 13 leftover.
    expect(computeInsets(29, 33, 10)).toEqual({ left: 10, right: 19, top: 10, bottom: 23 });
  });

  test('keeps the padding on all sides even with no leftover', () => {
    expect(computeInsets(20, 20, 10)).toEqual({ left: 10, right: 10, top: 10, bottom: 10 });
  });

  test('never returns a negative inset', () => {
    expect(computeInsets(0, 0, 0)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(computeInsets(-5, -5, 0)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });
});
