import { describe, expect, test } from 'bun:test';
import { overlayBox } from './composer-geometry';

describe('overlayBox', () => {
  const cell = { width: 9, height: 18 };

  test.each([
    ['up to the canvas right edge', { left: 90, top: 36 }, 800, 710],
    ['at least a cell at the right edge', { left: 795, top: 36 }, 800, 9],
    ['a cell without a canvas', { left: 90, top: 36 }, null, 9],
  ])('sits over the cursor cell, %s', (_name, spot, canvasRight, maxWidth) => {
    expect(overlayBox(spot, cell, canvasRight)).toEqual({
      left: spot.left,
      top: spot.top,
      height: 18,
      lineHeight: 18,
      maxWidth,
    });
  });
});
