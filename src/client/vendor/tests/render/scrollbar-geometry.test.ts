import { describe, expect, test } from 'bun:test';
import {
  inScrollbarColumn,
  SCROLLBAR_MIN_THUMB,
  scrollbarThumbHeight,
  scrollbarThumbY,
  scrollbarTrackHeight,
  scrollbarX,
} from '../../ghostty-web/render/scrollbar-geometry';

// The scrollbar's column, track and thumb, as both the painter and the hit test use them.

describe('scrollbar column', () => {
  test.each([
    [800, 788],
    [100, 88],
  ])('a %p px canvas puts the track at %p', (width, x) => {
    expect(scrollbarX(width)).toBe(x);
  });

  test.each([
    [787, false],
    [788, true],
    [792, true],
    [796, true],
    [797, false],
  ])('x %p on an 800 px canvas: %p', (x, inside) => {
    expect(inScrollbarColumn(x, 800)).toBe(inside);
  });
});

describe('scrollbar track and thumb', () => {
  test.each([
    [400, 392],
    [8, 0],
  ])('rows %p px high give a %p px track', (height, track) => {
    expect(scrollbarTrackHeight(height)).toBe(track);
  });

  test.each([
    ['all lines in view at once', 24, 24, 392, 196],
    ['a quarter of the lines', 24, 72, 392, 98],
    ['a long scrollback: the minimum', 24, 10000, 392, SCROLLBAR_MIN_THUMB],
  ])('%s', (_name, rows, scrollback, track, thumb) => {
    expect(scrollbarThumbHeight(rows, scrollback, track)).toBe(thumb);
  });

  test.each([
    ['at the bottom', 0, 100, 392, 92, 304],
    ['at the top', 100, 100, 392, 92, 4],
    ['half way', 50, 100, 392, 92, 154],
  ])('%s', (_name, viewportY, scrollback, track, thumb, y) => {
    expect(scrollbarThumbY(viewportY, scrollback, track, thumb)).toBe(y);
  });
});
