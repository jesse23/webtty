import { describe, expect, test } from 'bun:test';
import { pageZoom, snapZoom, ZOOM_LEVELS } from './page-zoom';

describe('snapZoom', () => {
  test.each([
    [1, 1],
    [1.1, 1.1],
    [1.105, 1.1],
    [0.667, 2 / 3],
    [1 / 3, 1 / 3],
    [1.75, 1.75],
    [5, 5],
    // Near no preset (a side panel open), or nonsense: 1
    [1.3, 1],
    [0.6, 1],
    [0, 1],
    [Number.NaN, 1],
  ])('%p is %p', (ratio, zoom) => expect(snapZoom(ratio)).toBe(zoom));

  test('every preset snaps to itself', () => {
    for (const level of ZOOM_LEVELS) expect(snapZoom(level)).toBe(level);
  });
});

describe('pageZoom', () => {
  test('is the outer width over the inner width, snapped to a preset', () => {
    expect(pageZoom({ outerWidth: 1400, innerWidth: 1273 })).toBe(1.1);
    expect(pageZoom({ outerWidth: 1400, innerWidth: 1400 })).toBe(1);
    expect(pageZoom({ outerWidth: 1400, innerWidth: 2100 })).toBe(2 / 3);
  });

  test('is 1 without the sizes, as outside a browser', () => {
    expect(pageZoom({})).toBe(1);
    expect(pageZoom({ outerWidth: 0, innerWidth: 800 })).toBe(1);
  });
});
