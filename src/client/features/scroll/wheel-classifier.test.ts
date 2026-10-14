import { describe, expect, test } from 'bun:test';
import { WheelClassifier } from './wheel-classifier';

describe('WheelClassifier', () => {
  const feed = (deltas: [number, number][]) => {
    const c = new WheelClassifier();
    for (const [x, y] of deltas) c.accept(x, y);
    return c.isPhysicalMouseWheel();
  };

  test('steady integer notches are a wheel', () => {
    expect(
      feed([
        [0, 4],
        [0, 4],
        [0, 8],
        [0, 4],
      ]),
    ).toBe(true);
  });

  test('fractional, accelerating deltas are a trackpad', () => {
    expect(
      feed([
        [0, 1.5],
        [0, 3.25],
        [0, 7.75],
        [0, 12.5],
      ]),
    ).toBe(false);
  });

  test('both axes at once are a trackpad', () => {
    expect(
      feed([
        [0, 4],
        [0, 4],
        [1, 4],
        [2, 6],
      ]),
    ).toBe(false);
  });

  test('no events is not a wheel', () => {
    expect(new WheelClassifier().isPhysicalMouseWheel()).toBe(false);
  });

  test('only the latest five deltas count', () => {
    // Three trackpad-like deltas, then five steady notches: the notches outweigh them.
    expect(
      feed([
        [1, 1.5],
        [2, 3.25],
        [3, 7.75],
        [0, 4],
        [0, 4],
        [0, 4],
        [0, 4],
        [0, 4],
      ]),
    ).toBe(true);
  });
});
