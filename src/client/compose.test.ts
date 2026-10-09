import { describe, expect, test } from 'bun:test';
import { computeCursorSpot } from './compose';

const grid = { cols: 80, rows: 24 };
const cell = { width: 9, height: 18 };
const canvas = { left: 0, top: 0 };

describe('computeCursorSpot', () => {
  test('puts the spot at the cursor cell', () => {
    expect(computeCursorSpot({ x: 10, y: 5 }, 0, grid, cell, canvas)).toEqual({
      left: 90,
      top: 90,
    });
  });

  test('offsets by the canvas position inside the padding', () => {
    expect(computeCursorSpot({ x: 0, y: 0 }, 0, grid, cell, { left: 12, top: 8 })).toEqual({
      left: 12,
      top: 8,
    });
  });

  test('moves down with the scrollback offset', () => {
    expect(computeCursorSpot({ x: 0, y: 5 }, 3, grid, cell, canvas).top).toBe(8 * 18);
  });

  test('stays on the last row once the cursor scrolls out of view', () => {
    expect(computeCursorSpot({ x: 0, y: 20 }, 100, grid, cell, canvas).top).toBe(23 * 18);
  });

  test('clamps a pending-wrap cursor to the last column', () => {
    expect(computeCursorSpot({ x: 80, y: 0 }, 0, grid, cell, canvas).left).toBe(79 * 9);
  });
});
