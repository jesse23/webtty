import { describe, expect, test } from 'bun:test';
import type { GhosttyCell } from '../../ghostty-web/engine/cell-types';
import {
  frameLines,
  type RowSource,
  rowContent,
  screenGraphemes,
  scrollbackGraphemes,
} from '../../ghostty-web/render/frame-lines';
import type { IRenderable } from '../../ghostty-web/render/renderable';
import { loadGhostty } from '../support/wasm';

// One frame's row reader: one viewport read, rows served as slices of it.

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
    const ghostty = await loadGhostty();
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

describe('the row a canvas row shows', () => {
  const screen = [[cellAt(0, 0)], [cellAt(1, 0)]];
  const scrollback = [[cellAt(90, 0)], [cellAt(91, 0)], [cellAt(92, 0)]];
  const buffer = {
    getGraphemeString: (row: number, col: number) => `screen ${row}:${col}`,
  } as unknown as IRenderable;
  const source: RowSource = {
    buffer,
    getLine: (y) => screen[y] ?? null,
    rows: 2,
    scrollback: {
      getScrollbackLine: (offset) => scrollback[offset],
      getScrollbackLength: () => 3,
      getScrollbackGraphemeString: (offset, col) => `scrollback ${offset}:${col}`,
    },
    scrollbackLength: 3,
  };

  // Viewport row y at viewportY 2: rows 0 and 1 are the last two scrollback lines
  test.each([
    [-2, null, undefined],
    [-1, 9000, 'scrollback 0:4'],
    [0, 9100, 'scrollback 1:4'],
    [1, 9200, 'scrollback 2:4'],
    [2, 0, 'screen 0:4'],
    [3, 100, 'screen 1:4'],
    [4, null, undefined],
  ])('viewport row %p', (y, codepoint, grapheme) => {
    const row = rowContent(source, y, 2);
    expect(row.line?.[0].codepoint ?? null).toBe(codepoint);
    expect(row.grapheme?.(4)).toBe(grapheme);
  });

  test('no scrollback: the rows above the screen are blank', () => {
    expect(rowContent({ ...source, scrollback: undefined }, 0, 1)).toEqual({ line: null });
  });

  test('a buffer or provider without grapheme lookups gives spaces', () => {
    expect(screenGraphemes(null, 0)(3)).toBe(' ');
    expect(screenGraphemes({} as IRenderable, 0)(3)).toBe(' ');
    const provider = { getScrollbackLine: () => null, getScrollbackLength: () => 0 };
    expect(scrollbackGraphemes(provider, 0)(3)).toBe(' ');
  });
});
