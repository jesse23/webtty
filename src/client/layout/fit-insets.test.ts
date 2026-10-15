import { describe, expect, test } from 'bun:test';
import { computeInsets } from './fit-insets';

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
