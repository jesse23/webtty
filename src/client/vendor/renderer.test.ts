import { describe, expect, test } from 'bun:test';
import { watchDevicePixelRatio, wholeDevicePixelRatio } from './ghostty-web/renderer';

describe('wholeDevicePixelRatio', () => {
  test('keeps a whole ratio', () => {
    expect(wholeDevicePixelRatio(1)).toBe(1);
    expect(wholeDevicePixelRatio(2)).toBe(2);
  });

  test('rounds a fractional ratio up', () => {
    expect(wholeDevicePixelRatio(1.25)).toBe(2);
    expect(wholeDevicePixelRatio(1.36)).toBe(2);
    expect(wholeDevicePixelRatio(2.5)).toBe(3);
  });

  test('ignores float noise on a whole ratio', () => {
    expect(wholeDevicePixelRatio(2.0000000298023224)).toBe(2);
    expect(wholeDevicePixelRatio(1.0000000149011612)).toBe(1);
  });

  test('never goes below 1', () => {
    expect(wholeDevicePixelRatio(0.5)).toBe(1);
    expect(wholeDevicePixelRatio(0)).toBe(1);
    expect(wholeDevicePixelRatio(undefined)).toBe(1);
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
});
