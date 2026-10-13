import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import { frameLines, watchDevicePixelRatio, wholeDevicePixelRatio } from './ghostty-web/renderer';
import type { GhosttyCell } from './ghostty-web/types';

const WASM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ghostty-web/ghostty-vt.wasm');

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

/** A cell whose codepoint records its row and column. */
function cellAt(y: number, x: number): GhosttyCell {
  return {
    codepoint: y * 100 + x,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

describe('frameLines', () => {
  const cols = 3;
  const rows = 2;
  const viewport = [0, 1].flatMap((y) => [0, 1, 2].map((x) => cellAt(y, x)));

  test('reads the viewport once per frame and slices rows from it', () => {
    let reads = 0;
    let lineReads = 0;
    const buffer = {
      getViewport: () => {
        reads++;
        return viewport;
      },
      getLine: () => {
        lineReads++;
        return null;
      },
    };
    const getLine = frameLines(buffer, cols, rows);
    expect(reads).toBe(0);
    expect(getLine(1)?.map((c) => c.codepoint)).toEqual([100, 101, 102]);
    expect(getLine(0)?.map((c) => c.codepoint)).toEqual([0, 1, 2]);
    expect(getLine(1)?.map((c) => c.codepoint)).toEqual([100, 101, 102]);
    expect(reads).toBe(1);
    expect(lineReads).toBe(0);
    frameLines(buffer, cols, rows)(0);
    expect(reads).toBe(2);
  });

  test('returns null outside the viewport', () => {
    const getLine = frameLines({ getViewport: () => viewport, getLine: () => null }, cols, rows);
    expect(getLine(-1)).toBeNull();
    expect(getLine(rows)).toBeNull();
  });

  test('falls back to getLine without getViewport', () => {
    const getLine = frameLines({ getLine: (y) => [cellAt(y, 0)] }, cols, rows);
    expect(getLine(1)?.[0].codepoint).toBe(100);
  });

  test('serves the same rows as getLine from a real terminal', async () => {
    const ghostty = await Ghostty.load(WASM);
    const term = ghostty.createTerminal(20, 5);
    term.write('\x1b[31mred\x1b[0m \x1b[1;44mbold\x1b[0m\r\n中文 ✓\r\n\x1b[7mrev\x1b[0m');
    term.update();
    const getLine = frameLines(term, 20, 5);
    for (let y = 0; y < 5; y++) {
      expect(getLine(y)).toEqual(term.getLine(y));
    }
    term.free();
  });
});
