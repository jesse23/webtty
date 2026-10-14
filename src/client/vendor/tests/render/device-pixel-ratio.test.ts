import { describe, expect, test } from 'bun:test';
import {
  watchDevicePixelRatio,
  wholeDevicePixelRatio,
} from '../../ghostty-web/render/device-pixel-ratio';

// The whole drawing ratio and the re-armed resolution query that follows ratio changes.

describe('wholeDevicePixelRatio', () => {
  test.each([
    ['a whole ratio', 1, 1],
    ['a whole ratio', 2, 2],
    ['a fractional ratio, rounded up', 1.25, 2],
    ['a fractional ratio, rounded up', 1.36, 2],
    ['a fractional ratio, rounded up', 2.5, 3],
    ['float noise on a whole ratio', 2.0000000298023224, 2],
    ['float noise on a whole ratio', 1.0000000149011612, 1],
    ['a ratio below 1', 0.5, 1],
    ['zero', 0, 1],
    ['no ratio', undefined, 1],
  ])('%s: %p -> %p', (_name, ratio, whole) => {
    expect(wholeDevicePixelRatio(ratio)).toBe(whole);
  });

  test('keeps the backing store a whole number of pixels', () => {
    const dpr = wholeDevicePixelRatio(1.36);
    expect(Number.isInteger(80 * 9 * dpr)).toBe(true);
  });
});

/** A window whose resolution queries can be fired by hand. */
function fakeWindow(ratio: number) {
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const win = {
    devicePixelRatio: ratio,
    matchMedia(media: string) {
      const query = { media, listeners: new Set<() => void>() };
      queries.push(query);
      return {
        addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
      } as unknown as MediaQueryList;
    },
  };
  const change = (next: number) => {
    const query = queries[queries.length - 1];
    win.devicePixelRatio = next;
    for (const listener of [...query.listeners]) {
      query.listeners.delete(listener);
      listener();
    }
  };
  return { win, queries, change };
}

describe('watchDevicePixelRatio', () => {
  test('watches the current ratio', () => {
    const { win, queries } = fakeWindow(2);
    watchDevicePixelRatio(win, () => {});
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 2dppx)']);
  });

  test('reports each change and re-arms for the new ratio', () => {
    const { win, queries, change } = fakeWindow(2);
    const seen: number[] = [];
    watchDevicePixelRatio(win, (ratio) => seen.push(ratio));
    change(1);
    change(1.25);
    expect(seen).toEqual([1, 1.25]);
    expect(queries.map((q) => q.media)).toEqual([
      '(resolution: 2dppx)',
      '(resolution: 1dppx)',
      '(resolution: 1.25dppx)',
    ]);
  });

  test('reads a missing ratio as 1', () => {
    const { win, queries, change } = fakeWindow(0);
    const seen: number[] = [];
    watchDevicePixelRatio(win, (ratio) => seen.push(ratio));
    change(0);
    expect(seen).toEqual([1]);
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)', '(resolution: 1dppx)']);
  });

  test('stops reporting once stopped', () => {
    const { win, queries, change } = fakeWindow(2);
    const seen: number[] = [];
    const stop = watchDevicePixelRatio(win, (ratio) => seen.push(ratio));
    change(1);
    stop();
    expect(queries[queries.length - 1].listeners.size).toBe(0);
    change(2);
    expect(seen).toEqual([1]);
  });

  test('does nothing without matchMedia', () => {
    const win = { devicePixelRatio: 2 } as Pick<Window, 'devicePixelRatio' | 'matchMedia'>;
    const stop = watchDevicePixelRatio(win, () => {
      throw new Error('never called');
    });
    expect(() => stop()).not.toThrow();
  });
});
