/**
 * Find (webtty, ADR 055): which cells of which rows the renderer paints in the search
 * colours, and where the view goes for the selected match.
 *
 * Matches come from libghostty-vt newest to oldest (`GhosttyTerminal.searchMatches`), so
 * their rows never increase along the list, and the matches over a range of rows are a
 * run of it, found by binary search: a frame costs the same with ten matches or a
 * hundred thousand.
 */
import type { ScreenRange } from './ghostty';

/** Matches as libghostty-vt's search found them, and the selected one. */
export interface SearchHighlights {
  /** Start col, start row, end col, end row per match, in screen rows, newest first. */
  matches: Int32Array;
  selected: ScreenRange | null;
}

/** Highlighted columns of one row, both ends inclusive. */
export interface HighlightSpan {
  start: number;
  end: number;
  selected: boolean;
}

/** The first index in `[0, n)` for which `past(i)` holds; `past` must be monotone. */
function firstWhere(n: number, past: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (past(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The run `[from, to)` of matches that touch screen rows `first` to `last`. */
export function matchesInRows(
  matches: Int32Array,
  first: number,
  last: number
): { from: number; to: number } {
  const n = matches.length >> 2;
  // Start rows fall along the list: the matches starting at or above `last` are a tail
  const from = firstWhere(n, (i) => matches[i * 4 + 1] <= last);
  // and of those, the ones ending at or below `first` a head
  const to = from + firstWhere(n - from, (i) => matches[(from + i) * 4 + 3] < first);
  return { from, to };
}

/**
 * The highlighted spans of screen rows `first` to `last`, by row. A match over a soft
 * wrap runs to the end of its first row and from the start of its last.
 */
export function highlightRows(
  highlights: SearchHighlights,
  first: number,
  last: number,
  cols: number
): Map<number, HighlightSpan[]> {
  const { matches, selected } = highlights;
  const rows = new Map<number, HighlightSpan[]>();
  const { from, to } = matchesInRows(matches, first, last);
  for (let i = from; i < to; i++) {
    const [sc, sr, ec, er] = matches.subarray(i * 4, i * 4 + 4);
    const isSelected =
      !!selected &&
      selected.start.col === sc &&
      selected.start.row === sr &&
      selected.end.col === ec &&
      selected.end.row === er;
    for (let row = Math.max(sr, first); row <= Math.min(er, last); row++) {
      const span = {
        start: row === sr ? sc : 0,
        end: row === er ? ec : cols - 1,
        selected: isSelected,
      };
      const spans = rows.get(row);
      if (spans) spans.push(span);
      else rows.set(row, [span]);
    }
  }
  return rows;
}

/** A row's spans as a string, to tell whether a row was drawn with the same ones. */
export function spansKey(spans: HighlightSpan[] | undefined): string {
  if (!spans) return '';
  return spans.map((s) => `${s.start}-${s.end}${s.selected ? '*' : ''}`).join(',');
}

/** 2 for a cell of the selected match, 1 for another match's, 0 for none. */
export function highlightAt(spans: HighlightSpan[] | undefined, col: number): 0 | 1 | 2 {
  if (!spans) return 0;
  for (const s of spans) {
    if (col >= s.start && col <= s.end) return s.selected ? 2 : 1;
  }
  return 0;
}

/**
 * The `viewportY` that shows `match` as Ghostty's search does: none (null) when any of
 * its rows is in view, otherwise the one with its first row at the top, clamped to the
 * scrollback.
 */
export function viewportYToShow(
  match: ScreenRange,
  scrollback: number,
  viewportY: number,
  rows: number
): number | null {
  const top = scrollback - Math.floor(viewportY);
  if (match.end.row >= top && match.start.row < top + rows) return null;
  return Math.max(0, Math.min(scrollback, scrollback - match.start.row));
}

/** Where the selected match was when the view last followed it. */
export interface FindAnchor {
  row: number;
  scrollback: number;
}

/**
 * The `viewportY` that keeps a scrolled view on its rows after output: it moves by the
 * lines that scrolled into the scrollback, what it grew by plus what was pruned from its
 * top (the rows the anchor's row moved up by).
 */
export function keptViewportY(
  viewportY: number,
  anchor: FindAnchor,
  row: number,
  scrollback: number
): number {
  return Math.max(
    0,
    Math.min(scrollback, viewportY + (scrollback - anchor.scrollback) + (anchor.row - row))
  );
}
