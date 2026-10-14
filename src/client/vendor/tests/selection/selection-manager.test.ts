import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ghostty, GhosttyTerminal } from '../../ghostty-web/ghostty';
import { atCell, fire, selectionFixture } from '../support/selection-fixture';
import { loadGhostty } from '../support/wasm';

// SelectionManager over the real engine: copy on select, Ghostty's selected text, the
// gestures' absolute rows across scrolling and output, the context menu and dispose.

describe('SelectionManager copy on select', () => {
  let wasmTerm: GhosttyTerminal;

  beforeEach(async () => {
    const ghostty = await loadGhostty();
    wasmTerm = ghostty.createTerminal(20, 4);
    wasmTerm.write('hello world\r\nsecond line');
  });

  afterEach(() => {
    wasmTerm.free();
  });

  /** A manager over the wasm terminal, counting the times it builds the selected text. */
  function manager(copyOnSelect: boolean) {
    const f = selectionFixture(wasmTerm, { copyOnSelect });
    let builds = 0;
    const getSelection = f.m.getSelection.bind(f.m);
    f.m.getSelection = () => {
      builds++;
      return getSelection();
    };
    return { ...f, builds: () => builds };
  }

  /** Drags across "hello" on row 0 and releases. */
  function drag(f: ReturnType<typeof manager>) {
    fire(f.canvas, 'mousedown', { button: 0, offsetX: 1, offsetY: 4 });
    fire(f.canvas, 'mousemove', { offsetX: 4 * 8 + 1, offsetY: 4 });
    fire(f.doc, 'mouseup');
  }

  test('a drag copies its text once, building it once', () => {
    const f = manager(true);
    drag(f);
    expect(f.writes).toEqual(['hello']);
    expect(f.builds()).toBe(1);
    expect(f.changes()).toBe(1);
  });

  test('a double and a triple click copy once each', () => {
    const f = manager(true);
    fire(f.canvas, 'click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    fire(f.canvas, 'click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(f.writes).toEqual(['world', 'second line']);
  });

  // The terminal's scrollLines is reached only from here, so a call graph from
  // src/client/index.ts does not show it.
  test('a drag below the terminal scrolls it down through scrollLines', () => {
    const f = manager(true);
    fire(f.canvas, 'mousedown', { button: 0, offsetX: 1, offsetY: 4 });
    fire(f.doc, 'mousemove', { clientX: 40, clientY: 100 });
    f.clock.advance(80);
    fire(f.doc, 'mouseup');
    expect(f.scrolls).toEqual([3]);
    // The release stopped the interval
    expect(f.clock.pending.timers).toBe(0);
  });

  // While the app tracks the mouse, a press is the app's; Shift selects (ADR 051)
  test('with mouse tracking on, a drag or a double click selects and copies nothing', () => {
    wasmTerm.write('\x1b[?1000h');
    const f = manager(true);
    drag(f);
    fire(f.canvas, 'click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    fire(f.canvas, 'click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(f.m.hasSelection()).toBe(false);
    expect(f.m.getSelectionRange()).toBeNull();
    expect(f.writes).toEqual([]);
    expect(f.changes()).toBe(0);
  });

  test('with mouse tracking on, Shift drag, double and triple click select and copy', () => {
    wasmTerm.write('\x1b[?1002h\x1b[?1006h');
    const f = manager(true);
    fire(f.canvas, 'mousedown', { button: 0, offsetX: 1, offsetY: 4, shiftKey: true });
    fire(f.canvas, 'mousemove', { offsetX: 4 * 8 + 1, offsetY: 4, shiftKey: true });
    fire(f.doc, 'mouseup');
    fire(f.canvas, 'click', { detail: 2, offsetX: 8 * 7, offsetY: 4, shiftKey: true });
    fire(f.canvas, 'click', { detail: 3, offsetX: 8, offsetY: 20, shiftKey: true });
    expect(f.writes).toEqual(['hello', 'world', 'second line']);
    expect(f.m.hasSelection()).toBe(false);
  });

  test('a copied selection is cleared, as Claude Code and pi clear theirs', () => {
    const f = manager(true);
    drag(f);
    expect(f.writes).toEqual(['hello']);
    expect(f.m.hasSelection()).toBe(false);
    expect(f.m.getSelectionRange()).toBeNull();
    expect(f.changes()).toBe(1);
  });

  test('a press the app takes leaves the current selection', () => {
    const f = manager(false);
    drag(f);
    wasmTerm.write('\x1b[?1000h');
    fire(f.canvas, 'mousedown', { button: 0, offsetX: 8 * 7, offsetY: 20 });
    fire(f.doc, 'mouseup');
    expect(f.m.getSelection()).toBe('hello');
  });

  test('nothing is copied or built with copyOnSelect off, but the change is reported', () => {
    const f = manager(false);
    drag(f);
    fire(f.canvas, 'click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    fire(f.canvas, 'click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(f.writes).toEqual([]);
    expect(f.builds()).toBe(0);
    expect(f.changes()).toBe(3);
    // The selection stays, to copy with Cmd+C, Ctrl+Shift+C or the menu.
    expect(f.m.hasSelection()).toBe(true);
  });

  test('copySelection copies the selection and reports whether there was one', () => {
    const f = manager(false);
    expect(f.m.copySelection()).toBe(false);
    drag(f);
    expect(f.m.copySelection()).toBe(true);
    expect(f.writes).toEqual(['hello']);
    // A selection of blank cells has no text to copy
    fire(f.canvas, 'mousedown', { button: 0, ...atCell(15, 3) });
    fire(f.canvas, 'mousemove', atCell(18, 3));
    fire(f.doc, 'mouseup');
    expect(f.m.hasSelection()).toBe(true);
    expect(f.m.copySelection()).toBe(false);
  });

  test('a right-click menu holds the selected text, or none', () => {
    const f = manager(false);
    f.m.prepareContextMenu({ clientX: 5, clientY: 6 } as MouseEvent);
    expect(f.textarea.value).toBe('');
    drag(f);
    f.m.prepareContextMenu({ clientX: 5, clientY: 6 } as MouseEvent);
    expect(f.textarea.value).toBe('hello');
    expect(f.textarea.style.left).toBe('5px');
  });
});

describe('SelectionManager dispose', () => {
  test('removes the document listeners it added, stops the auto-scroll, and runs once', async () => {
    const ghostty = await loadGhostty();
    const t = ghostty.createTerminal(10, 2);
    const f = selectionFixture(t);
    fire(f.canvas, 'mousedown', { button: 0, offsetX: 1, offsetY: 4 });
    fire(f.doc, 'mousemove', { clientX: 40, clientY: 100 });
    expect(f.clock.pending.timers).toBe(1);
    f.m.dispose();
    expect(f.clock.pending.timers).toBe(0);
    // The document mousedown and the canvas listeners leak until ADR 065
    expect(f.doc.active.map((r) => r.type)).toEqual(['mousedown']);
    expect(f.canvas.active.map((r) => r.type)).toEqual([
      'mousedown',
      'mousemove',
      'mouseleave',
      'mouseenter',
      'click',
    ]);
    const removed = f.doc.removed.length;
    f.m.dispose();
    expect(f.doc.removed.length).toBe(removed);
    t.free();
  });
});

describe("The selected text of wide characters (Ghostty's selectionText)", () => {
  let ghostty: Ghostty;

  beforeEach(async () => {
    ghostty = await loadGhostty();
  });

  /** The text a selection from (startCol, startRow) to (endCol, endRow) copies; rows are absolute. */
  function selected(
    wasmTerm: GhosttyTerminal,
    start: [number, number],
    end: [number, number],
  ): string {
    // getSelection passes its absolute rows to Ghostty's selectionText as they are
    return wasmTerm.selectionText({ col: start[0], row: start[1] }, { col: end[0], row: end[1] });
  }

  // Emoji with a skin tone, with VS16 (U+2764 U+FE0F) and a ZWJ family, and combining marks
  test('copies no space for the spacer after a CJK character or an emoji', () => {
    const t = ghostty.createTerminal(30, 4);
    t.write(
      '中文字 ok\r\n\u{1f44d}\u{1f3fd} \u2764\ufe0f \u{1f468}\u200d\u{1f469}\u200d\u{1f467} x\r\ne\u0301 a\u20dd',
    );
    expect(selected(t, [0, 0], [29, 2])).toBe(
      '中文字 ok\n\u{1f44d}\u{1f3fd} \u2764\ufe0f \u{1f468}\u200d\u{1f469}\u200d\u{1f467} x\ne\u0301 a\u20dd',
    );
    // A selection that starts or ends on the right half of a wide character
    expect(selected(t, [1, 0], [3, 0])).toBe('中文');
    t.free();
  });

  test('copies no space for a spacer at the last column, and joins the soft wrap', () => {
    // A wide character that does not fit wraps, leaving a spacer at the last column.
    // Ghostty joins soft-wrapped rows without a newline (ADR 050).
    const wrapped = ghostty.createTerminal(5, 4);
    wrapped.write('abcd中ef');
    expect(selected(wrapped, [0, 0], [4, 1])).toBe('abcd中ef');
    expect(selected(wrapped, [2, 0], [3, 0])).toBe('cd');
    // Ending on the spacer takes the wide character it stands for (Ghostty's formatter)
    expect(selected(wrapped, [2, 0], [4, 0])).toBe('cd中');
    wrapped.free();
    // A wide character ending at the last column
    const fits = ghostty.createTerminal(6, 4);
    fits.write('abcd中ef');
    expect(selected(fits, [3, 0], [1, 1])).toBe('d中ef');
    fits.free();
  });

  test('copies scrollback rows without spacers', () => {
    const t = ghostty.createTerminal(10, 2);
    t.write('中文 1\r\n日本語 2\r\nlast\r\nrow');
    expect(t.getScrollbackLength()).toBe(2);
    expect(selected(t, [0, 0], [9, 3])).toBe('中文 1\n日本語 2\nlast\nrow');
    t.free();
  });
});

// Behaviour the selection keeps on any engine API: mouse gestures over rows, absolute
// rows across scrolling and output, and the word and line a click picks.
describe('SelectionManager gestures', () => {
  let ghostty: Ghostty;

  beforeEach(async () => {
    ghostty = await loadGhostty();
  });

  /**
   * A manager over `wasmTerm` with 8x16 cells, scrolled up `viewportY()` lines. copyOnSelect
   * is off, so the selection a gesture makes stays to be read (on, it is copied and cleared).
   */
  function manager(wasmTerm: GhosttyTerminal, viewportY: () => number = () => 0) {
    return selectionFixture(wasmTerm, { viewportY });
  }

  type Fixture = ReturnType<typeof manager>;

  /** Drags from cell (c0, r0) to cell (c1, r1), in viewport rows, and releases. */
  function drag(f: Fixture, c0: number, r0: number, c1: number, r1: number) {
    fire(f.canvas, 'mousedown', { button: 0, ...atCell(c0, r0) });
    fire(f.canvas, 'mousemove', atCell(c1, r1));
    fire(f.doc, 'mouseup');
  }

  const click = (f: Fixture, detail: number, col: number, row: number) =>
    fire(f.canvas, 'click', { detail, ...atCell(col, row) });

  test('a drag backwards selects the same text as forwards', () => {
    const t = ghostty.createTerminal(20, 4);
    t.write('hello world\r\nsecond line');
    const f = manager(t);
    drag(f, 5, 1, 6, 0);
    expect(f.m.getSelection()).toBe('world\nsecond');
    expect(f.m.getSelectionRange()).toEqual({ startCol: 6, startRow: 0, endCol: 5, endRow: 1 });
    t.free();
  });

  test('a drag while scrolled selects scrollback rows, which stay selected at the bottom', () => {
    const t = ghostty.createTerminal(10, 2);
    t.write('one\r\ntwo\r\nthree\r\nfour');
    let viewportY = 2;
    const f = manager(t, () => viewportY);
    drag(f, 0, 0, 4, 1);
    expect(f.m.getSelection()).toBe('one\ntwo');
    viewportY = 0;
    expect(f.m.getSelection()).toBe('one\ntwo');
    expect(f.m.getSelectionRange()).toEqual({ startCol: 0, startRow: -2, endCol: 4, endRow: -1 });
    t.free();
  });

  test('a selection keeps its text while output arrives and scrolls it into history', () => {
    const t = ghostty.createTerminal(10, 3);
    t.write('keep me\r\n');
    const f = manager(t);
    drag(f, 0, 0, 6, 0);
    t.write('a\r\nb\r\nc\r\nd');
    expect(t.getScrollbackLength()).toBe(2);
    expect(f.m.getSelection()).toBe('keep me');
    expect(f.m.getSelectionRange()).toEqual({ startCol: 0, startRow: -2, endCol: 6, endRow: -2 });
    t.free();
  });

  test('a double click selects a word with path and address characters', () => {
    const t = ghostty.createTerminal(70, 2);
    t.write('ls /usr/local/bin/foo.txt a@b.c x+y ~/q "quoted" (paren) $HOME');
    const f = manager(t);
    const word = (col: number) => {
      click(f, 2, col, 0);
      return f.m.getSelection();
    };
    expect(word(8)).toBe('/usr/local/bin/foo.txt');
    expect(word(27)).toBe('a@b.c');
    expect(word(33)).toBe('x+y');
    expect(word(37)).toBe('~/q');
    expect(word(43)).toBe('quoted');
    expect(word(52)).toBe('paren');
    expect(word(59)).toBe('HOME');
    t.free();
  });

  test('a double click on an empty cell selects nothing', () => {
    const t = ghostty.createTerminal(20, 2);
    t.write('word');
    const f = manager(t);
    click(f, 2, 15, 0);
    expect(f.m.hasSelection()).toBe(false);
    expect(f.writes).toEqual([]);
    t.free();
  });

  test('a triple click selects the line without trailing spaces; an empty line selects nothing', () => {
    const t = ghostty.createTerminal(20, 3);
    t.write('one two   \r\n\r\nthree');
    const f = manager(t);
    click(f, 3, 15, 1);
    expect(f.m.hasSelection()).toBe(false);
    click(f, 3, 15, 0);
    expect(f.m.getSelection()).toBe('one two');
    click(f, 3, 0, 2);
    expect(f.m.getSelection()).toBe('three');
    t.free();
  });

  test('a triple click in scrollback selects that line', () => {
    const t = ghostty.createTerminal(10, 2);
    t.write('first\r\nsecond\r\nthird');
    const f = manager(t, () => 1);
    click(f, 3, 2, 0);
    expect(f.m.getSelection()).toBe('first');
    t.free();
  });

  test('a triple click with Ctrl or Cmd selects the command output; nothing outside it', () => {
    const t = ghostty.createTerminal(20, 6);
    t.write('\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07a.txt\r\nb.txt\r\n');
    t.write('\x1b]133;D;0\x07\x1b]133;A\x07$ ');
    const f = manager(t);
    const output = (row: number, mods: object) =>
      fire(f.canvas, 'click', { detail: 3, offsetX: 1, offsetY: row * 16 + 4, ...mods });
    output(2, { ctrlKey: true });
    expect(f.m.getSelection()).toBe('a.txt\nb.txt');
    f.m.clearSelection();
    output(1, { metaKey: true });
    expect(f.m.getSelection()).toBe('a.txt\nb.txt');
    output(1, {});
    expect(f.m.getSelection()).toBe('a.txt');
    f.m.clearSelection();
    output(3, { ctrlKey: true });
    expect(f.m.hasSelection()).toBe(false);
    t.free();
  });

  // Ghostty's selection rules (ADR 050)

  test('a selection across a soft wrap copies one line; a hard newline stays', () => {
    const t = ghostty.createTerminal(10, 4);
    t.write('0123456789abcdef\r\nnext');
    const f = manager(t);
    drag(f, 0, 0, 3, 2);
    expect(f.m.getSelection()).toBe('0123456789abcdef\nnext');
    t.free();
  });

  test('a double click selects a word that wraps onto the next row', () => {
    const t = ghostty.createTerminal(10, 3);
    t.write('cd /usr/local/bin');
    const f = manager(t);
    click(f, 2, 1, 1);
    expect(f.m.getSelection()).toBe('/usr/local/bin');
    expect(f.m.getSelectionRange()).toEqual({ startCol: 3, startRow: 0, endCol: 6, endRow: 1 });
    t.free();
  });

  test("a double click selects a URL query and non-ASCII words by Ghostty's word characters", () => {
    const t = ghostty.createTerminal(40, 2);
    t.write('see //x.io/a?b=c&d#e or café 中文字');
    const f = manager(t);
    click(f, 2, 8, 0);
    expect(f.m.getSelection()).toBe('//x.io/a?b=c&d#e');
    click(f, 2, 24, 0);
    expect(f.m.getSelection()).toBe('café');
    click(f, 2, 30, 0);
    expect(f.m.getSelection()).toBe('中文字');
    t.free();
  });

  test('a triple click selects a soft-wrapped line whole, without its indent', () => {
    const t = ghostty.createTerminal(8, 3);
    t.write('  wrapped line\r\nx');
    const f = manager(t);
    click(f, 3, 0, 1);
    expect(f.m.getSelection()).toBe('wrapped line');
    expect(f.m.getSelectionRange()).toEqual({ startCol: 2, startRow: 0, endCol: 5, endRow: 1 });
    t.free();
  });
});
