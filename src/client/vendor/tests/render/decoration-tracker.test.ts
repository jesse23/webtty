import { describe, expect, test } from 'bun:test';
import type { CellRange } from '../../ghostty-web/render/cell-range';
import { DecorationTracker } from '../../ghostty-web/render/decoration-tracker';
import { ROW_INVALID, ROW_JOINED } from '../../ghostty-web/render/row-band';
import type { SearchHighlights } from '../../ghostty-web/search';

const TOTAL = 12;
const state = () => new Uint8Array(TOTAL).fill(ROW_JOINED);
const invalid = (s: Uint8Array) => [...s.keys()].filter((k) => s[k] === ROW_INVALID);
/** All rows drawn, so the next mark only invalidates what changed. */
const settle = (t: DecorationTracker, s: Uint8Array, top: number, view = 0, sb = 0) => {
  t.mark(s, top, view, 10, sb);
  t.repainted(new Uint8Array(TOTAL).fill(1));
};

const range = (startRow: number, endRow: number): CellRange => ({
  startCol: 0,
  startRow,
  endCol: 3,
  endRow,
});

describe('DecorationTracker', () => {
  test('nothing to draw: no row changes, and the frame is empty', () => {
    const t = new DecorationTracker();
    const s = state();
    settle(t, s, 2);
    expect(invalid(s)).toEqual([]);
    expect(t.frame).toEqual({ selection: null, searchSpans: Array(TOTAL), link: null });
  });

  test('a selection is moved to canvas rows; old and new rows are changed', () => {
    const t = new DecorationTracker();
    let selection: CellRange | null = range(1, 2);
    t.setSelectionSource({
      hasSelection: () => selection !== null,
      getSelectionRange: () => selection,
    });
    let s = state();
    t.mark(s, 2, 0, 10, 0);
    expect(t.frame.selection).toEqual(range(3, 4));
    // changeRow also invalidates the joined row above
    expect(invalid(s)).toEqual([2, 3, 4]);
    s = state();
    t.mark(s, 2, 0, 10, 0);
    expect(invalid(s)).toEqual([]);
    selection = null;
    s = state();
    t.mark(s, 2, 0, 10, 0);
    expect(invalid(s)).toEqual([2, 3, 4]);
  });

  test('a selection past the canvas is clamped to its rows', () => {
    const t = new DecorationTracker();
    t.setSelectionSource({ hasSelection: () => true, getSelectionRange: () => range(-8, 40) });
    const s = state();
    t.mark(s, 2, 0, 10, 0);
    expect(invalid(s)).toEqual([...Array(TOTAL).keys()]);
  });

  test('a hovered link changes its rows, and the rows it left', () => {
    const t = new DecorationTracker();
    t.setHoveredLink(range(4, 4));
    let s = state();
    t.mark(s, 1, 0, 10, 0);
    expect(t.frame.link).toEqual(range(5, 5));
    expect(invalid(s)).toEqual([4, 5]);
    t.setHoveredLink(null);
    s = state();
    t.mark(s, 1, 0, 10, 0);
    expect(invalid(s)).toEqual([4, 5]);
    expect(t.frame.link).toBeNull();
  });

  test('search spans per canvas row; a row is changed until it is drawn with them', () => {
    const t = new DecorationTracker();
    // One match on screen row 1 (scrollback 5), columns 2-4
    const highlights: SearchHighlights = {
      matches: new Uint32Array([2, 6, 4, 6]),
      selected: null,
    } as unknown as SearchHighlights;
    t.setSearchHighlights(highlights);
    let s = state();
    // Viewport row 0 at canvas row 3, at the bottom: screen row 1 is canvas row 4
    t.mark(s, 3, 0, 10, 5);
    expect(t.frame.searchSpans[4]).toEqual([{ start: 2, end: 4, selected: false }]);
    expect(invalid(s)).toEqual([3, 4]);
    // Not drawn yet: changed again
    s = state();
    t.mark(s, 3, 0, 10, 5);
    expect(invalid(s)).toEqual([3, 4]);
    t.repainted(Uint8Array.from({ length: TOTAL }, (_, k) => (k === 4 ? 1 : 0)));
    s = state();
    t.mark(s, 3, 0, 10, 5);
    expect(invalid(s)).toEqual([]);
  });

  test('a copied scroll moves what the rows were drawn with', () => {
    const t = new DecorationTracker();
    t.setSelectionSource({ hasSelection: () => true, getSelectionRange: () => range(1, 1) });
    t.setHoveredLink(range(2, 2));
    settle(t, state(), 2);
    // The content moved down 3 rows and the viewport's top with it
    t.shift(3, TOTAL);
    const s = state();
    t.mark(s, 5, 0, 10, 0);
    expect(invalid(s)).toEqual([]);
  });
});
