import { beforeAll, describe, expect, test } from 'bun:test';
import { CellFlags, DirtyState } from '../../ghostty-web/engine/cell-types';
import { RenderState } from '../../ghostty-web/engine/render-state';
import type { Ghostty, GhosttyTerminal, OfficialTerminal } from '../../ghostty-web/ghostty';
import { freeContext, renderContext, writeVt } from '../support/engine-harness';
import { BG, BLUE, bgRgb, FG, RED, rgb, rowText, THEME } from '../support/terminal-text';
import { countedGhostty, loadGhostty } from '../support/wasm';

// The render-state binding (ADR 042, ADR 061): cells decoded from Ghostty's render state,
// the dirty rows, and the once-per-generation refresh, through the facade and directly.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('render state: cells', () => {
  test('reads 16-colour, 256-colour and truecolor foregrounds and backgrounds', () => {
    const t = term();
    t.write(
      '\x1b[31mA\x1b[0m\x1b[38;5;208mB\x1b[0m\x1b[38;2;10;20;30;48;2;200;100;50mC\x1b[0m' +
        '\x1b[44mD\x1b[0mE\x1b[48;5;21m  \x1b[0m',
    );
    const line = t.getLine(0);
    expect(line).not.toBeNull();
    const [a, b, c, d, e, f] = line ?? [];
    expect(rgb(a)).toBe(RED);
    expect(bgRgb(a)).toBe(BG);
    expect(rgb(b)).toBe(0xff8700);
    expect(rgb(c)).toBe(0x0a141e);
    expect(bgRgb(c)).toBe(0xc86432);
    expect(bgRgb(d)).toBe(BLUE);
    expect(rgb(d)).toBe(FG);
    expect(rgb(e)).toBe(FG);
    expect(bgRgb(e)).toBe(BG);
    // Spaces written with a 256-colour background.
    expect(f.codepoint).toBe(0x20);
    expect(bgRgb(f)).toBe(0x0000ff);
    t.free();
  });

  test('reads bold, italic, underline, strikethrough, inverse, faint, blink and invisible', () => {
    const t = term();
    t.write(
      '\x1b[1mA\x1b[0m\x1b[3mB\x1b[0m\x1b[4mC\x1b[0m\x1b[9mD\x1b[0m\x1b[7mE\x1b[0m' +
        '\x1b[2mF\x1b[0m\x1b[5mG\x1b[0m\x1b[8mH\x1b[0m\x1b[1;3;4;7mI\x1b[0mJ',
    );
    const flags = (t.getLine(0) ?? []).slice(0, 10).map((c) => c.flags);
    expect(flags).toEqual([
      CellFlags.BOLD,
      CellFlags.ITALIC,
      CellFlags.UNDERLINE,
      CellFlags.STRIKETHROUGH,
      CellFlags.INVERSE,
      CellFlags.FAINT,
      CellFlags.BLINK,
      CellFlags.INVISIBLE,
      CellFlags.BOLD | CellFlags.ITALIC | CellFlags.UNDERLINE | CellFlags.INVERSE,
      0,
    ]);
    t.free();
  });

  test('reads wide CJK, emoji, VS16 and combining marks as graphemes', () => {
    const t = term();
    t.write('你好|😀|❤️|é|👨‍👩‍👧');
    const line = t.getLine(0) ?? [];
    expect(line.slice(0, 5).map((c) => c.width)).toEqual([2, 0, 2, 0, 1]);
    expect(String.fromCodePoint(line[0].codepoint)).toBe('你');
    expect(line[5].width).toBe(2);
    expect(String.fromCodePoint(line[5].codepoint)).toBe('😀');
    // VS16 makes the heart wide (mode 2027 on by default).
    expect(line[8].width).toBe(2);
    expect(line[8].grapheme_len).toBe(1);
    expect(t.getGraphemeString(0, 8)).toBe('❤️');
    expect(line[11].grapheme_len).toBe(1);
    expect(t.getGraphemeString(0, 11)).toBe('é');
    expect([...t.getGraphemeString(0, 11)].map((c) => c.codePointAt(0))).toEqual([0x65, 0x301]);
    expect(t.getGraphemeString(0, 13)).toBe('👨‍👩‍👧');
    expect(line[13].width).toBe(2);
    expect(rowText(t, 0)).toBe('你好|😀|❤️|é|👨‍👩‍👧');
    t.free();
  });
});

describe('render state: dirty rows and colours', () => {
  test('keeps row dirt until markClean and only marks changed rows', () => {
    const t = term(20, 5);
    t.write('one\r\ntwo\r\nthree');
    t.update();
    t.markClean();
    expect(t.update()).toBe(DirtyState.NONE);
    t.write('\x1b[2;1HTWO');
    expect(t.update()).toBe(DirtyState.PARTIAL);
    expect(t.update()).toBe(DirtyState.PARTIAL);
    expect(t.isRowDirty(1)).toBe(true);
    expect(t.isRowDirty(0)).toBe(false);
    expect(t.isRowDirty(3)).toBe(false);
    expect(rowText(t, 1)).toBe('TWO');
    t.clearDirty();
    expect(t.isRowDirty(1)).toBe(false);
    t.write('\x1b[?1049h');
    expect(t.needsFullRedraw()).toBe(true);
    t.free();
  });

  // Ghostty marks no row dirty when only the default colours change; the binding bakes
  // them into every cell, so it must redecode every row itself.
  const everyCell = (t: GhosttyTerminal, rows: number, f: (c: never) => number) =>
    Array.from({ length: rows }, (_, y) => (t.getLine(y) ?? []).map((c) => f(c as never)));

  test('recolours every row when OSC 10/11 change only the default colours', () => {
    const t = term(10, 3);
    t.write('a\r\nb\r\nc');
    t.update();
    t.markClean();
    t.write('\x1b]11;rgb:44/55/66\x1b\\');
    expect(t.update()).toBe(DirtyState.FULL);
    for (let y = 0; y < 3; y++) expect(t.isRowDirty(y)).toBe(true);
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(0x445566));
    t.markClean();
    t.write('\x1b]10;rgb:11/22/33\x1b\\');
    expect(t.update()).toBe(DirtyState.FULL);
    expect(everyCell(t, 3, rgb).flat()).toEqual(Array(30).fill(0x112233));
    t.write('\x1b[1;1HX');
    t.update();
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(0x445566));
    t.markClean();
    t.write('\x1b]111\x1b\\\x1b]110\x1b\\');
    t.update();
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(BG));
    expect(everyCell(t, 3, rgb).flat()).toEqual(Array(30).fill(FG));
    t.free();
  });

  test('recolours every row on DECSCNM (?5h / ?5l)', () => {
    const t = term(10, 3);
    t.write('a\r\nb\r\nc');
    t.update();
    t.markClean();
    t.write('\x1b[?5h');
    expect(t.update()).toBe(DirtyState.FULL);
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(FG));
    t.markClean();
    t.write('\x1b[2;1HB');
    t.update();
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(FG));
    t.markClean();
    t.write('\x1b[?5l');
    expect(t.update()).toBe(DirtyState.FULL);
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(BG));
    expect(everyCell(t, 3, rgb).flat()).toEqual(Array(30).fill(FG));
    t.free();
  });
});

describe('RenderState', () => {
  test('refreshes once per generation, however many reads a frame makes', async () => {
    const { ghostty, calls } = await countedGhostty(['ghostty_render_state_update']);
    const ctx = renderContext(ghostty, 10, 3);
    const render = new RenderState(ctx);
    writeVt(ctx, 'abc');
    render.update();
    render.getCursor();
    render.isRowDirty(0);
    render.getViewport();
    expect(calls.ghostty_render_state_update).toBe(1);
    ctx.generation++;
    render.update();
    expect(calls.ghostty_render_state_update).toBe(2);
    render.free();
    freeContext(ctx);
  });

  test('reads the cursor and the active rows of the copy', () => {
    const ctx = renderContext(vt, 10, 3);
    const render = new RenderState(ctx);
    writeVt(ctx, 'ab\r\ncd\x1b[4 q');
    render.refresh();
    expect(render.getCursor()).toEqual({
      x: 2,
      y: 1,
      viewportX: 2,
      viewportY: 1,
      visible: true,
      blinking: false,
      style: 'underline',
    });
    const row = render.viewRow(1);
    expect(row.base).toBe(10);
    expect(String.fromCodePoint(row.cells[row.base + 1].codepoint)).toBe('d');
    writeVt(ctx, '\x1b[6 q');
    expect(render.getCursor().style).toBe('bar');
    render.free();
    freeContext(ctx);
  });

  test('markAllDirty makes the next frame full; markClean forgets it', () => {
    const ctx = renderContext(vt, 10, 3);
    const render = new RenderState(ctx);
    writeVt(ctx, 'a');
    render.update();
    render.markClean();
    expect(render.update()).toBe(DirtyState.NONE);
    render.markAllDirty();
    expect(render.update()).toBe(DirtyState.FULL);
    expect(render.isRowDirty(2)).toBe(true);
    render.markClean();
    expect(render.isRowDirty(2)).toBe(false);
    render.free();
    freeContext(ctx);
  });

  test('resized sizes the copy to the new grid and redecodes every row', () => {
    const ctx = renderContext(vt, 10, 3);
    const render = new RenderState(ctx);
    writeVt(ctx, 'one\r\ntwo');
    render.update();
    render.markClean();
    ctx.cols = 12;
    ctx.rows = 4;
    expect(ctx.ex.ghostty_terminal_resize(ctx.term, 12, 4, 0, 0)).toBe(0);
    ctx.generation++;
    render.resized();
    expect(render.getViewport().length).toBe(48);
    expect(render.update()).toBe(DirtyState.FULL);
    expect(String.fromCodePoint(render.viewRow(1).cells[12 + 2].codepoint)).toBe('o');
    render.free();
    freeContext(ctx);
  });

  test('a grapheme longer than the scratch buffer is read through its own allocation', () => {
    const ctx = renderContext(vt, 10, 3);
    const render = new RenderState(ctx);
    const marks = '́'.repeat(40);
    writeVt(ctx, `e${marks}x`);
    render.refresh();
    const row = render.viewRow(0);
    expect(row.cells[0].grapheme_len).toBe(40);
    expect(row.graphemes?.get(0)).toBe(`e${marks}`);
    expect(String.fromCodePoint(row.cells[1].codepoint)).toBe('x');
    render.free();
    freeContext(ctx);
  });

  test('decodePage reads every row of another render state into fresh rows', () => {
    const ctx = renderContext(vt, 8, 3);
    const render = new RenderState(ctx);
    writeVt(ctx, 'top\r\nmid\r\nend');
    render.refresh();
    const rs = ctx.vt.newHandle('render_state_new', (slot) =>
      ctx.ex.ghostty_render_state_new(0, slot),
    );
    expect(ctx.ex.ghostty_render_state_update(rs, ctx.term)).toBe(0);
    const page = render.decodePage(rs);
    expect(page.length).toBe(3);
    expect(page.map((r) => r.base)).toEqual([0, 0, 0]);
    expect(page[2].cells.length).toBe(8);
    expect(String.fromCodePoint(page[2].cells[0].codepoint)).toBe('e');
    // Fresh cells, not the active copy's.
    expect(page[0].cells).not.toBe(render.getViewport());
    ctx.ex.ghostty_render_state_free(rs);
    render.free();
    freeContext(ctx);
  });
});
