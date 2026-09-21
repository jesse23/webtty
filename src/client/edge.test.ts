import { describe, expect, test } from 'bun:test';
import { computeEdgeRects } from './edge';

const canvas = { left: 0, top: 0, width: 800, height: 400 };

describe('computeEdgeRects', () => {
  test('puts a strip under and to the right of the canvas', () => {
    expect(computeEdgeRects(canvas, { width: 809, height: 407 }, 0)).toEqual({
      bottom: { x: 0, y: 400, width: 800, height: 7 },
      right: { x: 800, y: 0, width: 9, height: 400 },
    });
  });

  test('has no strip when the canvas fills the container exactly', () => {
    expect(computeEdgeRects(canvas, { width: 800, height: 400 }, 0)).toEqual({
      bottom: null,
      right: null,
    });
  });

  test('leaves the configured padding on the far side to the padding colour', () => {
    // padding 10: canvas at (10, 10); 16 left below the canvas, 10 of it padding.
    const padded = { left: 10, top: 10, width: 800, height: 400 };
    expect(computeEdgeRects(padded, { width: 826, height: 426 }, 10)).toEqual({
      bottom: { x: 10, y: 410, width: 800, height: 6 },
      right: { x: 810, y: 10, width: 6, height: 400 },
    });
  });

  test('has no strip when only the padding is left', () => {
    const padded = { left: 10, top: 10, width: 800, height: 400 };
    expect(computeEdgeRects(padded, { width: 820, height: 420 }, 10)).toEqual({
      bottom: null,
      right: null,
    });
  });
});
