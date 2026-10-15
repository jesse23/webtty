import { describe, expect, test } from 'bun:test';
import {
  absoluteRowToViewport,
  clampedOffset,
  orderedViewportRange,
  outsideRect,
  pastDragThreshold,
  pixelToCell,
  verticalOverflow,
  viewportRowToAbsolute,
  wholeViewportY,
} from '../../ghostty-web/selection/selection-coords';

// The selection's coordinate maths, table-driven.

const RECT = { left: 10, top: 20, right: 90, bottom: 100 };

describe('selection coordinates', () => {
  test.each([
    [0, 0],
    [2.7, 2],
    [-3, 0],
  ])('wholeViewportY(%p) is %p', (raw, whole) => {
    expect(wholeViewportY(raw)).toBe(whole);
  });

  // [viewport row, scrollback length, viewportY, absolute row]
  test.each([
    [0, 0, 0, 0],
    [0, 5, 0, 5],
    [3, 5, 2, 6],
    [0, 5, 5, 0],
  ])(
    'viewport row %p with %p lines of scrollback at viewportY %p is absolute row %p',
    (row, len, y, abs) => {
      expect(viewportRowToAbsolute(row, len, y)).toBe(abs);
      expect(absoluteRowToViewport(abs, len, y)).toBe(row);
    },
  );

  const grid = { cellWidth: 8, cellHeight: 16, scrollOffset: 0, cols: 10, rows: 4 };

  test.each([
    [0, 0, grid, { col: 0, row: 0 }],
    [17, 33, grid, { col: 2, row: 2 }],
    // Clamped to the grid on every side
    [-5, -5, grid, { col: 0, row: 0 }],
    [500, 500, grid, { col: 9, row: 3 }],
    // Row 0 starts the scroll offset below the canvas top (ADR 043)
    [0, 20, { ...grid, scrollOffset: 6 }, { col: 0, row: 0 }],
    [0, 22, { ...grid, scrollOffset: 6 }, { col: 0, row: 1 }],
  ])('pixel (%p, %p) is cell %j', (x, y, g, cell) => {
    expect(pixelToCell(x, y, g)).toEqual(cell);
  });

  test('orderedViewportRange puts the start first and maps rows to the viewport', () => {
    const down = (row: number) => row - 2;
    const a = { col: 4, absoluteRow: 5 };
    const b = { col: 1, absoluteRow: 7 };
    const forwards = { startCol: 4, startRow: 3, endCol: 1, endRow: 5 };
    expect(orderedViewportRange(a, b, down)).toEqual(forwards);
    expect(orderedViewportRange(b, a, down)).toEqual(forwards);
    // On one row, by column
    const left = { col: 1, absoluteRow: 5 };
    expect(orderedViewportRange(a, left, down)).toEqual({
      startCol: 1,
      startRow: 3,
      endCol: 4,
      endRow: 3,
    });
  });

  // [dx, dy, cell width, past]: the threshold is half a cell width
  test.each([
    [0, 0, 8, false],
    [3, 0, 8, false],
    [4, 0, 8, true],
    [3, 3, 8, true],
    [0, -5, 8, true],
  ])('a move of (%p, %p) with %p px cells is past the threshold: %p', (dx, dy, w, past) => {
    expect(pastDragThreshold(dx, dy, w)).toBe(past);
  });

  test.each([
    [50, 50, false],
    [10, 20, false],
    [90, 100, false],
    [9, 50, true],
    [91, 50, true],
    [50, 19, true],
    [50, 101, true],
  ])('(%p, %p) is outside the rectangle: %p', (x, y, outside) => {
    expect(outsideRect(RECT, x, y)).toBe(outside);
  });

  test.each([
    [50, 50, { offsetX: 40, offsetY: 30 }],
    [0, 0, { offsetX: 0, offsetY: 0 }],
    [200, 300, { offsetX: 80, offsetY: 80 }],
  ])('(%p, %p) clamped into the rectangle is %j', (x, y, offset) => {
    expect(clampedOffset(RECT, x, y)).toEqual(offset);
  });

  test.each([
    [19, -1],
    [20, 0],
    [100, 0],
    [101, 1],
  ])('a pointer at y %p is past the rectangle by %p', (y, direction) => {
    expect(verticalOverflow(RECT, y)).toBe(direction as -1 | 0 | 1);
  });
});
