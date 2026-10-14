import { beforeAll, describe, expect, test } from 'bun:test';
import { RenderState } from '../../ghostty-web/engine/render-state';
import { PAGE_CACHE_SIZE, ScrollbackPages } from '../../ghostty-web/engine/scrollback-pages';
import { Ghostty, type OfficialTerminal } from '../../ghostty-web/ghostty';
import { freeContext, renderContext, writeVt } from '../support/engine-harness';
import { lines, rowText, scrollbackText, THEME } from '../support/terminal-text';
import { countedGhostty, instantiateWasm, loadGhostty } from '../support/wasm';

// The scrollback page cache (ADR 043, ADR 061): rows above the active screen read a page
// at a time, kept per generation, least recently used dropped first.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('scrollback pages: through the terminal', () => {
  test('keeps scrolled-off rows, oldest first', () => {
    const t = term(20, 5, { scrollbackLines: 0 });
    t.write(lines(50));
    expect(t.getScrollbackLength()).toBe(45);
    expect(scrollbackText(t, 0)).toBe('line 1');
    expect(scrollbackText(t, 44)).toBe('line 45');
    expect(t.getScrollbackLine(45)).toBeNull();
    expect(rowText(t, 0)).toBe('line 46');
    expect(rowText(t, 4)).toBe('line 50');
    t.free();
  });

  test('keeps active-screen coordinates while the view is scrolled up', () => {
    const t = term(20, 5, { scrollbackLines: 0 });
    t.write(lines(50));
    t.setViewportOffset(7);
    expect(t.isRowDirty(0)).toBe(true);
    expect(rowText(t, 0)).toBe('line 46');
    expect(rowText(t, 4)).toBe('line 50');
    expect(scrollbackText(t, 38)).toBe('line 39');
    expect(scrollbackText(t, 44)).toBe('line 45');
    const viewport = t.getViewport();
    expect(viewport.length).toBe(100);
    expect(String.fromCodePoint(viewport[80 + 5].codepoint)).toBe('5');
    expect(t.getCursor()).toMatchObject({ x: 7, y: 4 });
    // Output snaps the view back to the bottom.
    t.write('\r\nline 51');
    expect(rowText(t, 4)).toBe('line 51');
    expect(t.needsFullRedraw()).toBe(true);
    t.free();
  });

  test('a scroll step decodes nothing and moves no viewport once its page is cached', async () => {
    const real = (await instantiateWasm()).exports as Record<string, (...args: number[]) => number>;
    const calls = { update: 0, rows: 0, scroll: 0 };
    const counted =
      (name: string, key: keyof typeof calls) =>
      (...args: number[]) => {
        calls[key]++;
        return real[name](...args);
      };
    const spy = {
      ...real,
      ghostty_render_state_update: counted('ghostty_render_state_update', 'update'),
      ghostty_render_state_row_get_multi: counted('ghostty_render_state_row_get_multi', 'rows'),
      ghostty_terminal_scroll_viewport: counted('ghostty_terminal_scroll_viewport', 'scroll'),
    };
    const spied = new Ghostty(spy as unknown as ConstructorParameters<typeof Ghostty>[0]);
    const t = spied.createTerminal(20, 5, { scrollbackLines: 0 });
    t.write(lines(50));
    const sb = t.getScrollbackLength();
    expect(sb).toBe(45);
    // One frame as the renderer reads it at viewportY = k.
    const frame = (k: number) => {
      t.setViewportOffset(k);
      t.getCursor();
      t.needsFullRedraw();
      const view = t.getViewport();
      const shown: string[] = [];
      for (let y = 0; y < t.rows; y++) {
        if (y < k) {
          const line = t.getScrollbackLine(sb - k + y) ?? [];
          for (let x = 0; x < line.length; x++) t.getScrollbackGraphemeString(sb - k + y, x);
          shown.push(
            line
              .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
              .join('')
              .trimEnd(),
          );
        } else {
          const row = view.slice((y - k) * t.cols, (y - k + 1) * t.cols);
          shown.push(
            row
              .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
              .join('')
              .trimEnd(),
          );
        }
        t.isRowDirty(y);
      }
      t.markClean();
      return shown;
    };
    const expected = (k: number) =>
      Array.from({ length: 5 }, (_, y) => `line ${50 - 5 - k + y + 1}`);
    frame(0);
    // The first walk reads each scrollback page once: 45 rows in pages of 5.
    const first = { ...calls };
    for (let k = 1; k <= sb; k++) expect(frame(k)).toEqual(expected(k));
    expect(calls.update - first.update).toBe(9);
    expect(calls.rows - first.rows).toBe(9 * 5);
    // Each page read moves the viewport there and back; nothing else moves it.
    expect(calls.scroll - first.scroll).toBe(9 * 2);
    // Every page is cached now: a walk back down and up again costs no export call.
    const warm = { ...calls };
    for (let k = sb; k >= 0; k--) expect(frame(k)).toEqual(k ? expected(k) : expected(0));
    for (let k = 0; k <= sb + 10; k++) frame(k);
    expect(calls).toEqual(warm);
    // Output while scrolled: one refresh of the active rows, no viewport move, and
    // the first frame at the bottom repaints every row.
    t.setViewportOffset(12);
    t.write('\r\nline 51');
    expect(t.needsFullRedraw()).toBe(true);
    expect(calls.update - warm.update).toBe(1);
    expect(calls.scroll).toBe(warm.scroll);
    expect(rowText(t, 4)).toBe('line 51');
    t.markClean();
    // Resize while scrolled: no viewport move, and the reflowed rows are read anew.
    t.setViewportOffset(12);
    const beforeResize = calls.scroll;
    t.resize(30, 4);
    expect(calls.scroll).toBe(beforeResize);
    expect(t.getScrollbackLength()).toBe(47);
    expect(scrollbackText(t, 46)).toBe('line 47');
    expect(rowText(t, 3)).toBe('line 51');
    t.free();
  });
});

describe('ScrollbackPages', () => {
  const UPDATE = 'ghostty_render_state_update';

  async function setup(rows: number, written: number) {
    const { ghostty, calls } = await countedGhostty([UPDATE, 'ghostty_terminal_scroll_viewport']);
    const ctx = renderContext(ghostty, 20, rows);
    const render = new RenderState(ctx);
    const pages = new ScrollbackPages(ctx, render);
    writeVt(ctx, lines(written));
    render.refresh();
    const text = (abs: number) => {
      const row = pages.rowAt(abs);
      return row.cells
        .slice(row.base, row.base + 20)
        .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
        .join('')
        .trimEnd();
    };
    const done = () => {
      pages.free();
      render.free();
      freeContext(ctx);
    };
    return { ctx, render, pages, calls, text, done };
  }

  test('rowAt serves scrollback from pages and active rows from the render state', async () => {
    const { ctx, render, calls, text, done } = await setup(2, 7);
    expect(ctx.sbRows).toBe(5);
    expect(text(0)).toBe('line 1');
    expect(text(4)).toBe('line 5');
    expect(text(5)).toBe('line 6');
    expect(text(6)).toBe('line 7');
    // Two page reads (rows 0-1 and 4-5); rows 5 and 6 came from the active copy.
    expect(calls[UPDATE]).toBe(1 + 2);
    expect(calls.ghostty_terminal_scroll_viewport).toBe(2 * 2);
    expect(render.viewRow(0).cells).toBe(render.getViewport());
    done();
  });

  test('keeps the most recently used pages and drops the oldest past the limit', async () => {
    const pagesRead = PAGE_CACHE_SIZE + 2;
    const { calls, text, done } = await setup(2, pagesRead * 2 + 2);
    for (let p = 0; p < pagesRead; p++) text(p * 2);
    const afterWalk = calls[UPDATE];
    // The last 16 pages are cached: no read.
    text((pagesRead - 1) * 2);
    text(2 * 2 + 1);
    expect(calls[UPDATE]).toBe(afterWalk);
    // Pages 0 and 1 were dropped: each costs a read again.
    expect(text(0)).toBe('line 1');
    expect(text(3)).toBe('line 4');
    expect(calls[UPDATE]).toBe(afterWalk + 2);
    done();
  });

  test('a hit moves its page to the back, so the least recently used goes first', async () => {
    const { calls, text, done } = await setup(2, (PAGE_CACHE_SIZE + 1) * 2 + 2);
    for (let p = 0; p < PAGE_CACHE_SIZE; p++) text(p * 2);
    // Touch page 0, then read one more page: page 1 is the one dropped.
    text(0);
    text(PAGE_CACHE_SIZE * 2);
    const before = calls[UPDATE];
    text(1);
    expect(calls[UPDATE]).toBe(before);
    text(2);
    expect(calls[UPDATE]).toBe(before + 1);
    done();
  });

  test('a new generation drops every page and the second render state', async () => {
    const { ctx, render, calls, text, done } = await setup(2, 7);
    text(0);
    const before = calls[UPDATE];
    text(1);
    expect(calls[UPDATE]).toBe(before);
    writeVt(ctx, '\r\nline 8');
    render.refresh();
    expect(text(0)).toBe('line 1');
    // One refresh of the active rows, one page read.
    expect(calls[UPDATE]).toBe(before + 2);
    done();
  });

  test('free releases the second render state once', async () => {
    const { pages, text, done } = await setup(2, 7);
    text(0);
    done();
    expect(() => pages.free()).not.toThrow();
  });
});
