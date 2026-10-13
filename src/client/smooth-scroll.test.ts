import { describe, expect, test } from 'bun:test';
import { splitScroll, wheelLines } from './smooth-scroll';

describe('splitScroll', () => {
  test('a whole-line position has no offset', () => {
    expect(splitScroll(3, 14, 2)).toEqual({ line: 3, offset: 0 });
  });

  test('the fraction becomes a pixel offset below the whole line', () => {
    expect(splitScroll(3.5, 14, 2)).toEqual({ line: 3, offset: 7 });
  });

  test('snaps the offset to device pixels', () => {
    // 0.3 x 14 = 4.2 CSS px = 8.4 device px at 2x, snapped to 8 device px.
    expect(splitScroll(0.3, 14, 2)).toEqual({ line: 0, offset: 4 });
    expect(splitScroll(0.3, 14, 1)).toEqual({ line: 0, offset: 4 });
    expect(splitScroll(0.25, 14, 2)).toEqual({ line: 0, offset: 3.5 });
  });

  test('rounding up to a full cell moves to the next line', () => {
    expect(splitScroll(2.99, 14, 1)).toEqual({ line: 3, offset: 0 });
  });
});

describe('wheelLines', () => {
  test('converts pixel deltas by the cell height', () => {
    expect(wheelLines({ deltaY: 7, deltaMode: 0 }, 14, 40)).toBe(0.5);
    expect(wheelLines({ deltaY: -28, deltaMode: 0 }, 14, 40)).toBe(-2);
  });

  test('passes line deltas through', () => {
    expect(wheelLines({ deltaY: 3, deltaMode: 1 }, 14, 40)).toBe(3);
  });

  test('scales page deltas by the row count', () => {
    expect(wheelLines({ deltaY: -1, deltaMode: 2 }, 14, 40)).toBe(-40);
  });
});
