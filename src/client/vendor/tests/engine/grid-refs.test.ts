import { beforeAll, describe, expect, test } from 'bun:test';
import { GridRefs, gridRefSlots } from '../../ghostty-web/engine/grid-refs';
import type { Ghostty, OfficialTerminal } from '../../ghostty-web/ghostty';
import { bindingContext, freeContext, writeVt } from '../support/engine-harness';
import { THEME } from '../support/terminal-text';
import { loadGhostty } from '../support/wasm';

// Cells read through Ghostty grid refs (ADR 042, ADR 061): OSC 8 hyperlink URIs on screen
// and in scrollback, wrap flags, and the cell lookups the selection and search use.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('official engine: hyperlinks (ADR 042)', () => {
  test('marks OSC 8 hyperlinks and resolves their URIs on screen and in scrollback', () => {
    const t = term(40, 5);
    t.write('\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ plain');
    expect((t.getLine(0) ?? []).slice(0, 6).map((c) => c.hyperlink_id)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(t.getHyperlinkUri(0, 0)).toBe('https://example.com/a');
    expect(t.getHyperlinkUri(0, 5)).toBeNull();
    t.write('\r\n'.repeat(10));
    expect(t.getScrollbackLength()).toBeGreaterThan(0);
    expect(t.getScrollbackHyperlinkUri(0, 3)).toBe('https://example.com/a');
    expect(t.getScrollbackHyperlinkUri(0, 6)).toBeNull();
    // Longer than the first buffer tried.
    const long = `https://example.com/${'p'.repeat(1500)}`;
    t.write(`\x1b]8;;${long}\x1b\\long\x1b]8;;\x1b\\`);
    expect(t.getHyperlinkUri(t.getCursor().y, 0)).toBe(long);
    t.free();
  });
});

describe('GridRefs', () => {
  function refs(cols = 10, rows = 3) {
    const ctx = bindingContext(vt, cols, rows, gridRefSlots(vt.L));
    return { ctx, refs: new GridRefs(ctx) };
  }

  test('a screen cell goes to a grid ref and back; cells off the grid have none', () => {
    const { ctx, refs: r } = refs();
    writeVt(ctx, 'abc\r\ndef');
    expect(r.screenRef({ col: 2, row: 1 }, ctx.at.gridRef)).toBe(true);
    expect(r.screenCellOf(ctx.at.gridRef)).toEqual({ col: 2, row: 1 });
    expect(r.screenRef({ col: -1, row: 0 }, ctx.at.gridRef)).toBe(false);
    expect(r.screenRef({ col: 10, row: 0 }, ctx.at.gridRef)).toBe(false);
    expect(r.screenRef({ col: 0, row: -1 }, ctx.at.gridRef)).toBe(false);
    // A row past the screen is a point Ghostty refuses
    expect(r.screenRef({ col: 0, row: 99 }, ctx.at.gridRef)).toBe(false);
    freeContext(ctx);
  });

  test('isRowWrapped is true only for a row that continues the one above', () => {
    const { ctx, refs: r } = refs(5, 3);
    writeVt(ctx, 'abcdefg\r\nxy');
    expect([0, 1, 2].map((row) => r.isRowWrapped(row))).toEqual([false, true, false]);
    expect(r.isRowWrapped(-1)).toBe(false);
    expect(r.isRowWrapped(3)).toBe(false);
    freeContext(ctx);
  });

  test('hyperlinkAt is null off the grid and on a plain cell', () => {
    const { ctx, refs: r } = refs();
    writeVt(ctx, '\x1b]8;;https://a.b\x1b\\ln\x1b]8;;\x1b\\ x');
    const P = ctx.L.point;
    expect(r.hyperlinkAt(P.ACTIVE, 0, 0)).toBe('https://a.b');
    expect(r.hyperlinkAt(P.ACTIVE, 3, 0)).toBeNull();
    expect(r.hyperlinkAt(P.ACTIVE, -1, 0)).toBeNull();
    expect(r.hyperlinkAt(P.ACTIVE, 10, 0)).toBeNull();
    expect(r.hyperlinkAt(P.ACTIVE, 0, -1)).toBeNull();
    expect(r.hyperlinkAt(P.ACTIVE, 0, 99)).toBeNull();
    freeContext(ctx);
  });
});
