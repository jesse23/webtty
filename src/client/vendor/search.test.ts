import { describe, expect, test } from 'bun:test';
import {
  highlightAt,
  highlightRows,
  keptViewportY,
  matchesInRows,
  spansKey,
  viewportYToShow,
} from './ghostty-web/search';

// Find (ADR 055): highlights from libghostty-vt's newest-to-oldest matches, and the view.

/** Matches as [start col, start row, end col, end row], newest first. */
const list = (...m: number[][]) => Int32Array.from(m.flat());

describe('matchesInRows', () => {
  // Rows 9, 7-8 (over a wrap), 7, 4 and 0
  const matches = list([2, 9, 4, 9], [7, 8, 1, 9], [0, 7, 2, 7], [3, 4, 5, 4], [0, 0, 1, 0]);

  test('finds the run of matches touching the rows', () => {
    expect(matchesInRows(matches, 4, 7)).toEqual({ from: 2, to: 4 });
    expect(matchesInRows(matches, 9, 9)).toEqual({ from: 0, to: 2 });
    expect(matchesInRows(matches, 0, 100)).toEqual({ from: 0, to: 5 });
  });

  test('a match over a wrap touches both its rows', () => {
    expect(matchesInRows(matches, 8, 8)).toEqual({ from: 1, to: 2 });
  });

  test('is empty between, above and below the matches', () => {
    for (const [first, last] of [
      [5, 6],
      [10, 20],
      [-5, -1],
    ]) {
      const { from, to } = matchesInRows(matches, first, last);
      expect(to).toBe(from);
    }
    expect(matchesInRows(list(), 0, 10)).toEqual({ from: 0, to: 0 });
  });

  test('takes a hundred thousand matches in a few steps', () => {
    const many = new Int32Array(100_000 * 4);
    for (let i = 0; i < 100_000; i++) many.set([0, 99_999 - i, 0, 99_999 - i], i * 4);
    expect(matchesInRows(many, 500, 509)).toEqual({ from: 99_490, to: 99_500 });
  });
});

describe('highlightRows', () => {
  test('gives each row its spans, a wrapped match to the end and from the start', () => {
    const matches = list([7, 8, 1, 9], [0, 7, 2, 7], [5, 7, 6, 7]);
    const rows = highlightRows(
      { matches, selected: { start: { col: 0, row: 7 }, end: { col: 2, row: 7 } } },
      7,
      9,
      10,
    );
    expect(rows.get(9)).toEqual([{ start: 0, end: 1, selected: false }]);
    expect(rows.get(8)).toEqual([{ start: 7, end: 9, selected: false }]);
    expect(rows.get(7)).toEqual([
      { start: 0, end: 2, selected: true },
      { start: 5, end: 6, selected: false },
    ]);
  });

  test('leaves out rows outside the range', () => {
    const rows = highlightRows({ matches: list([7, 8, 1, 9]), selected: null }, 9, 12, 10);
    expect([...rows.keys()]).toEqual([9]);
  });
});

describe('highlightAt and spansKey', () => {
  const spans = [
    { start: 0, end: 2, selected: true },
    { start: 5, end: 6, selected: false },
  ];

  test('tells a selected match from another and from none', () => {
    expect([0, 2, 3, 5, 6, 7].map((c) => highlightAt(spans, c))).toEqual([2, 2, 0, 1, 1, 0]);
    expect(highlightAt(undefined, 0)).toBe(0);
  });

  test('keys a row by its spans', () => {
    expect(spansKey(spans)).toBe('0-2*,5-6');
    expect(spansKey(undefined)).toBe('');
    expect(spansKey([{ ...spans[0], selected: false }])).not.toBe(spansKey([spans[0]]));
  });
});

describe('viewportYToShow', () => {
  const at = (start: number, end = start) => ({
    start: { col: 0, row: start },
    end: { col: 0, row: end },
  });
  // 100 scrollback lines, 10 rows: at the bottom the view shows rows 100-109

  test('does not move when any row of the match is in view', () => {
    expect(viewportYToShow(at(105), 100, 0, 10)).toBeNull();
    expect(viewportYToShow(at(99, 100), 100, 0, 10)).toBeNull();
    expect(viewportYToShow(at(60), 100, 45, 10)).toBeNull();
  });

  test("puts the match's first row at the top, as Ghostty does", () => {
    expect(viewportYToShow(at(40, 41), 100, 0, 10)).toBe(60);
    expect(viewportYToShow(at(0), 100, 0, 10)).toBe(100);
  });

  test('a match on the screen below the view scrolls down to it, clamped to the bottom', () => {
    expect(viewportYToShow(at(108), 100, 30, 10)).toBe(0);
  });
});

describe('keptViewportY', () => {
  test('moves with lines that scrolled into the scrollback', () => {
    expect(keptViewportY(20, { row: 50, scrollback: 100 }, 50, 103)).toBe(23);
  });

  test('moves with lines pruned from the top of a full scrollback', () => {
    expect(keptViewportY(20, { row: 50, scrollback: 100 }, 47, 100)).toBe(23);
  });

  test('stays within the scrollback', () => {
    expect(keptViewportY(99, { row: 5, scrollback: 100 }, 0, 100)).toBe(100);
  });
});
