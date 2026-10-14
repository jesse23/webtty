import { describe, expect, test } from 'bun:test';
import { axisScale, cellSpan, deviceCellSize } from './cell-geometry';

describe('cellSpan', () => {
  const img = { width: 100, height: 50 };

  test('natural size rounds up to whole cells', () => {
    expect(cellSpan({}, img, 8, 16)).toEqual({ cols: 13, rows: 4 });
  });

  test('c and r win', () => {
    expect(cellSpan({ c: '10', r: '5' }, img, 8, 16)).toEqual({ cols: 10, rows: 5 });
  });

  test('c alone keeps the aspect ratio', () => {
    // 20 cols * 8px = 160px wide → scale 1.6 → 80px tall → 5 rows of 16px
    expect(cellSpan({ c: '20' }, img, 8, 16)).toEqual({ cols: 20, rows: 5 });
  });

  test('r alone keeps the aspect ratio', () => {
    // 4 rows * 16px = 64px tall → scale 1.28 → 128px wide → 16 cols of 8px
    expect(cellSpan({ r: '4' }, img, 8, 16)).toEqual({ cols: 16, rows: 4 });
  });

  test('the span follows the region passed in, not the whole image', () => {
    // A 16x32 source rectangle at 2x is 8x16 CSS px: one cell, not the two the
    // device-pixel numbers would suggest.
    expect(cellSpan({ w: '16', h: '32' }, { width: 16 / 2, height: 32 / 2 }, 8, 16)).toEqual({
      cols: 1,
      rows: 1,
    });
  });
});

describe('device pixel scale', () => {
  test('cell size is a whole number of device pixels', () => {
    expect(deviceCellSize(9.6, 2)).toBe(19);
    expect(deviceCellSize(9.6, 1.25)).toBe(12);
    expect(deviceCellSize(9.6, 1.5)).toBe(14);
    expect(deviceCellSize(0.2, 1)).toBe(1);
  });

  test.each([1, 1.25, 1.5, 1.75, 2, 3])(
    'a frame of cols cells fills cols CSS cells exactly at dpr %p',
    (dpr) => {
      const cols = 200;
      const cssCell = 9.6;
      const frameWidth = cols * deviceCellSize(cssCell, dpr);
      expect(frameWidth / axisScale(cssCell, dpr)).toBeCloseTo(cols * cssCell, 6);
    },
  );

  test('raw devicePixelRatio would drift off the grid at fractional scales', () => {
    const cols = 200;
    const cssCell = 9.6;
    const drawn = (cols * deviceCellSize(cssCell, 1.75)) / 1.75;
    expect(Math.abs(drawn - cols * cssCell)).toBeGreaterThan(5);
  });

  test('scale follows the snapped cell, close to devicePixelRatio', () => {
    expect(axisScale(9.6, 2)).toBeCloseTo(19 / 9.6, 10);
    expect(axisScale(0, 2)).toBe(2);
  });
});

describe('cellSpan at fractional display scales', () => {
  // A program sizes an image as whole cells of the size it was told; converting
  // that back to CSS pixels must give the same number of cells, not one more
  // because of floating-point error.
  test.each([1, 1.25, 1.5, 1.75, 2, 3])(
    'a whole number of cells stays that many at dpr %p',
    (dpr) => {
      for (const css of [7.8, 8.4, 9.6, 10.2]) {
        for (const cells of [1, 2, 3, 7, 80, 213]) {
          const devCell = deviceCellSize(css, dpr);
          const region = { width: (cells * devCell) / axisScale(css, dpr), height: 1 };
          expect(cellSpan({}, region, css, 1).cols).toBe(cells);
        }
      }
    },
  );
});
