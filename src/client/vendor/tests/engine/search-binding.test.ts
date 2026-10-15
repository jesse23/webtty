import { beforeAll, describe, expect, test } from 'bun:test';
import { GridRefs, gridRefSlots } from '../../ghostty-web/engine/grid-refs';
import { SearchBinding, searchSlots } from '../../ghostty-web/engine/search-binding';
import type { Ghostty, OfficialTerminal } from '../../ghostty-web/ghostty';
import { bindingContext, freeContext, writeVt } from '../support/engine-harness';
import { THEME } from '../support/terminal-text';
import { countedGhostty, loadGhostty } from '../support/wasm';

// The wasm search (ADR 055, ADR 061): matches found a step at a time, newest first, the
// selected match, and the restart and pruning rules, through OfficialTerminal and directly.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('official engine: search (ADR 055)', () => {
  /** Runs the search to completion and returns its matches as [col, row, col, row] tuples. */
  function run(t: OfficialTerminal): number[][] {
    while (t.searchStep(50)) {}
    const m = t.searchMatches();
    return Array.from({ length: m.length / 4 }, (_, i) => Array.from(m.slice(i * 4, i * 4 + 4)));
  }

  test('finds ASCII letters case-insensitively, newest first, scrollback included', () => {
    const t = term(20, 3);
    t.write('Error one\r\nok\r\nerror two\r\nok\r\nERROR three');
    t.setSearch('error');
    expect(run(t)).toEqual([
      [0, 4, 4, 4],
      [0, 2, 4, 2],
      [0, 0, 4, 0],
    ]);
    expect(t.getScrollbackLength()).toBe(2);
    expect(t.searchState()).toEqual({ total: 3, selected: null });
    t.free();
  });

  test('a match spans a soft wrap', () => {
    const t = term(5, 3);
    t.write('abcdefg');
    t.setSearch('def');
    expect(run(t)).toEqual([[3, 0, 0, 1]]);
    t.free();
  });

  test('next moves toward older output and wraps; previous moves back', () => {
    const t = term(10, 4);
    t.write('a x\r\nb x\r\nc x');
    t.setSearch('x');
    run(t);
    const row = () => t.searchSelectedMatch()?.start.row;
    expect(t.searchSelectedMatch()).toBeNull();
    expect(t.searchSelect('next')).toBe(true);
    expect([t.searchState().selected, row()]).toEqual([0, 2]);
    t.searchSelect('next');
    expect([t.searchState().selected, row()]).toEqual([1, 1]);
    t.searchSelect('next');
    t.searchSelect('next');
    expect([t.searchState().selected, row()]).toEqual([0, 2]);
    t.searchSelect('previous');
    expect([t.searchState().selected, row()]).toEqual([2, 0]);
    expect(t.searchSelectedMatch()).toEqual({ start: { col: 2, row: 0 }, end: { col: 2, row: 0 } });
    t.free();
  });

  test('picks up output after a step, and leaves the view alone', () => {
    const t = term(10, 3);
    t.write('x\r\n');
    t.setSearch('x');
    expect(run(t)).toHaveLength(1);
    expect(t.searchStep(50)).toBe(false);
    t.write('x\r\nx\r\nx\r\n');
    expect(run(t)).toHaveLength(4);
    t.searchSelect('previous');
    expect(t.searchSelectedMatch()?.start.row).toBe(0);
    // SCROLL_NONE: the top row of Ghostty's viewport is still the active screen's
    expect(t.getLine(0)?.[0].codepoint).toBe('x'.codePointAt(0));
    t.free();
  });

  test('a new needle restarts the search; an empty one ends it', () => {
    const t = term(10, 3);
    t.write('foo bar');
    t.setSearch('foo');
    expect(run(t)).toEqual([[0, 0, 2, 0]]);
    t.setSearch('BAR');
    expect(run(t)).toEqual([[4, 0, 6, 0]]);
    t.setSearch('');
    expect(t.searchStep(50)).toBe(false);
    expect(t.searchMatches()).toHaveLength(0);
    expect(t.searchState()).toEqual({ total: 0, selected: null });
    expect(t.searchSelect('next')).toBe(false);
    t.free();
  });

  test('matches pruned from the scrollback go away', () => {
    const t = term(10, 2, { scrollbackLines: 1000 });
    t.write('x0\r\n');
    t.setSearch('x');
    expect(run(t)).toHaveLength(1);
    t.write('y\r\n'.repeat(5000));
    expect(run(t)).toHaveLength(0);
    t.free();
  });

  test('reads more matches than its buffer held', () => {
    const t = term(40, 5, { scrollbackLines: 1000 });
    t.setSearch('ab');
    t.write('ab\r\n');
    expect(run(t)).toHaveLength(1);
    t.write('ab ab ab ab ab\r\n'.repeat(100));
    const all = run(t);
    expect(all).toHaveLength(501);
    expect(t.searchState().total).toBe(501);
    // Newest to oldest: rows never increase
    for (let i = 1; i < all.length; i++) expect(all[i][1]).toBeLessThanOrEqual(all[i - 1][1]);
    t.free();
  });
});

describe('SearchBinding', () => {
  test('without a needle every read is empty and nothing is made', async () => {
    const { ghostty, calls } = await countedGhostty(['ghostty_search_new']);
    const ctx = bindingContext(ghostty, 10, 3, {
      ...gridRefSlots(ghostty.L),
      ...searchSlots(ghostty.L),
    });
    const search = new SearchBinding(ctx, new GridRefs(ctx));
    expect(search.searchStep(10)).toBe(false);
    expect(search.searchSelect('next')).toBe(false);
    expect(search.searchState()).toEqual({ total: 0, selected: null });
    expect(search.searchSelectedMatch()).toBeNull();
    expect(search.searchMatches()).toEqual(new Int32Array(0));
    search.setSearch('');
    expect(calls.ghostty_search_new).toBe(0);
    freeContext(ctx);
  });

  test('free() frees the search and its match buffer once; a second call is a no-op', async () => {
    const { ghostty, calls } = await countedGhostty(['ghostty_search_free', 'ghostty_wasm_free']);
    const ctx = bindingContext(ghostty, 10, 3, {
      ...gridRefSlots(ghostty.L),
      ...searchSlots(ghostty.L),
    });
    const search = new SearchBinding(ctx, new GridRefs(ctx));
    writeVt(ctx, 'ab ab ab');
    search.setSearch('ab');
    while (search.searchStep(50)) {}
    expect(search.searchMatches().length).toBe(12);
    const frees = calls.ghostty_wasm_free;
    search.free();
    expect(calls.ghostty_search_free).toBe(1);
    // The match buffer
    expect(calls.ghostty_wasm_free).toBe(frees + 1);
    search.free();
    expect([calls.ghostty_search_free, calls.ghostty_wasm_free]).toEqual([1, frees + 1]);
    expect(search.searchState()).toEqual({ total: 0, selected: null });
    freeContext(ctx);
  });
});
