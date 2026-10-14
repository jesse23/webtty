import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, type GhosttyTerminal } from '../ghostty-web/ghostty';
import type { CanvasRenderer } from '../ghostty-web/renderer';
import { SelectionManager } from '../ghostty-web/selection-manager';
import type { Terminal } from '../ghostty-web/terminal';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../ghostty-vt/ghostty-vt-small.wasm',
);

type Listener = (e: object) => void;

/** An event target that keeps its listeners, so a test can dispatch to them by hand. */
function target() {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    removeEventListener: () => {},
    dispatch: (type: string, e: object) => {
      for (const listener of listeners.get(type) ?? []) listener(e);
    },
  };
}

describe('SelectionManager copy on select', () => {
  const doc = globalThis.document;
  const nav = globalThis.navigator;
  let documentTarget: ReturnType<typeof target>;
  let writes: string[];
  let wasmTerm: GhosttyTerminal;

  beforeEach(async () => {
    documentTarget = target();
    globalThis.document = documentTarget as unknown as Document;
    writes = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: {
          writeText: async (text: string) => {
            writes.push(text);
          },
        },
      },
    });
    const ghostty = await Ghostty.load(WASM);
    wasmTerm = ghostty.createTerminal(20, 4);
    wasmTerm.write('hello world\r\nsecond line');
  });

  afterEach(() => {
    wasmTerm.free();
    globalThis.document = doc;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
  });

  /** A manager over the wasm terminal, counting the times it builds the selected text. */
  function manager(copyOnSelect: boolean, scrolls: number[] = []) {
    const canvas = {
      ...target(),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 160, bottom: 64 }),
    };
    const terminal = {
      cols: 20,
      rows: 4,
      options: { copyOnSelect },
      getViewportY: () => 0,
      scrollLines: (amount: number) => scrolls.push(amount),
    } as unknown as Terminal;
    const renderer = {
      getCanvas: () => canvas,
      getMetrics: () => ({ width: 8, height: 16 }),
      scrollOffset: 0,
    } as unknown as CanvasRenderer;
    const textarea = { style: {} } as HTMLTextAreaElement;
    const m = new SelectionManager(terminal, renderer, wasmTerm, textarea);
    let builds = 0;
    const getSelection = m.getSelection.bind(m);
    m.getSelection = () => {
      builds++;
      return getSelection();
    };
    let changes = 0;
    m.onSelectionChange(() => changes++);
    return { m, canvas, builds: () => builds, changes: () => changes };
  }

  /** Drags across "hello" on row 0 and releases. */
  function drag(canvas: ReturnType<typeof target>) {
    canvas.dispatch('mousedown', { button: 0, offsetX: 1, offsetY: 4 });
    canvas.dispatch('mousemove', { offsetX: 4 * 8 + 1, offsetY: 4 });
    documentTarget.dispatch('mouseup', {});
  }

  test('a drag copies its text once, building it once', () => {
    const { canvas, builds, changes } = manager(true);
    drag(canvas);
    expect(writes).toEqual(['hello']);
    expect(builds()).toBe(1);
    expect(changes()).toBe(1);
  });

  test('a double and a triple click copy once each', () => {
    const { canvas } = manager(true);
    canvas.dispatch('click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    canvas.dispatch('click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(writes).toEqual(['world', 'second line']);
  });

  // The terminal's scrollLines is reached only from here, so a call graph from
  // src/client/index.ts does not show it.
  test('a drag below the terminal scrolls it down through scrollLines', async () => {
    const scrolls: number[] = [];
    const { canvas } = manager(true, scrolls);
    canvas.dispatch('mousedown', { button: 0, offsetX: 1, offsetY: 4 });
    documentTarget.dispatch('mousemove', { clientX: 40, clientY: 100 });
    await Bun.sleep(80);
    documentTarget.dispatch('mouseup', {});
    expect(scrolls.length).toBeGreaterThan(0);
    expect(scrolls.every((amount) => amount === 3)).toBe(true);
  });

  // While the app tracks the mouse, a press is the app's; Shift selects (ADR 051)
  test('with mouse tracking on, a drag or a double click selects and copies nothing', () => {
    wasmTerm.write('\x1b[?1000h');
    const { m, canvas, changes } = manager(true);
    drag(canvas);
    canvas.dispatch('click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    canvas.dispatch('click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(m.hasSelection()).toBe(false);
    expect(m.getSelectionRange()).toBeNull();
    expect(writes).toEqual([]);
    expect(changes()).toBe(0);
  });

  test('with mouse tracking on, Shift drag, double and triple click select and copy', () => {
    wasmTerm.write('\x1b[?1002h\x1b[?1006h');
    const { m, canvas } = manager(true);
    canvas.dispatch('mousedown', { button: 0, offsetX: 1, offsetY: 4, shiftKey: true });
    canvas.dispatch('mousemove', { offsetX: 4 * 8 + 1, offsetY: 4, shiftKey: true });
    documentTarget.dispatch('mouseup', {});
    canvas.dispatch('click', { detail: 2, offsetX: 8 * 7, offsetY: 4, shiftKey: true });
    canvas.dispatch('click', { detail: 3, offsetX: 8, offsetY: 20, shiftKey: true });
    expect(writes).toEqual(['hello', 'world', 'second line']);
    expect(m.hasSelection()).toBe(false);
  });

  test('a copied selection is cleared, as Claude Code and pi clear theirs', () => {
    const { m, canvas, changes } = manager(true);
    drag(canvas);
    expect(writes).toEqual(['hello']);
    expect(m.hasSelection()).toBe(false);
    expect(m.getSelectionRange()).toBeNull();
    expect(changes()).toBe(1);
  });

  test('a press the app takes leaves the current selection', () => {
    const { m, canvas } = manager(false);
    drag(canvas);
    wasmTerm.write('\x1b[?1000h');
    canvas.dispatch('mousedown', { button: 0, offsetX: 8 * 7, offsetY: 20 });
    documentTarget.dispatch('mouseup', {});
    expect(m.getSelection()).toBe('hello');
  });

  test('nothing is copied or built with copyOnSelect off, but the change is reported', () => {
    const { m, canvas, builds, changes } = manager(false);
    drag(canvas);
    canvas.dispatch('click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    canvas.dispatch('click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(writes).toEqual([]);
    expect(builds()).toBe(0);
    expect(changes()).toBe(3);
    // The selection stays, to copy with Cmd+C, Ctrl+Shift+C or the menu.
    expect(m.hasSelection()).toBe(true);
  });
});

describe('SelectionManager text of wide characters', () => {
  const doc = globalThis.document;
  let ghostty: Ghostty;

  beforeEach(async () => {
    globalThis.document = target() as unknown as Document;
    ghostty = await Ghostty.load(WASM);
  });

  afterEach(() => {
    globalThis.document = doc;
  });

  /** The text a selection from (startCol, startRow) to (endCol, endRow) copies; rows are absolute. */
  function selected(
    wasmTerm: GhosttyTerminal,
    start: [number, number],
    end: [number, number],
  ): string {
    const m = new SelectionManager(
      { cols: wasmTerm.cols, rows: wasmTerm.rows, options: {} } as unknown as Terminal,
      { getCanvas: () => target() } as unknown as CanvasRenderer,
      wasmTerm,
      { style: {} } as HTMLTextAreaElement,
    );
    const internal = m as unknown as Record<string, { col: number; absoluteRow: number }>;
    internal.selectionStart = { col: start[0], absoluteRow: start[1] };
    internal.selectionEnd = { col: end[0], absoluteRow: end[1] };
    return m.getSelection();
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
  const doc = globalThis.document;
  const nav = globalThis.navigator;
  let documentTarget: ReturnType<typeof target>;
  let ghostty: Ghostty;
  let writes: string[];

  beforeEach(async () => {
    documentTarget = target();
    globalThis.document = documentTarget as unknown as Document;
    writes = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (text: string) => void writes.push(text) } },
    });
    ghostty = await Ghostty.load(WASM);
  });

  afterEach(() => {
    globalThis.document = doc;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
  });

  /** A manager over `wasmTerm` with 8x16 cells, scrolled up `viewportY()` lines. */
  function manager(wasmTerm: GhosttyTerminal, viewportY: () => number = () => 0) {
    const canvas = {
      ...target(),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: wasmTerm.cols * 8,
        bottom: wasmTerm.rows * 16,
      }),
    };
    const terminal = {
      cols: wasmTerm.cols,
      rows: wasmTerm.rows,
      // Off, so the selection a gesture makes stays to be read (on, it is copied and cleared)
      options: { copyOnSelect: false },
      getViewportY: viewportY,
      scrollLines: () => {},
    } as unknown as Terminal;
    const renderer = {
      getCanvas: () => canvas,
      getMetrics: () => ({ width: 8, height: 16 }),
      scrollOffset: 0,
    } as unknown as CanvasRenderer;
    const m = new SelectionManager(terminal, renderer, wasmTerm, {
      style: {},
    } as HTMLTextAreaElement);
    return { m, canvas };
  }

  /** Drags from cell (c0, r0) to cell (c1, r1), in viewport rows, and releases. */
  function drag(canvas: ReturnType<typeof target>, c0: number, r0: number, c1: number, r1: number) {
    canvas.dispatch('mousedown', { button: 0, offsetX: c0 * 8 + 1, offsetY: r0 * 16 + 4 });
    canvas.dispatch('mousemove', { offsetX: c1 * 8 + 1, offsetY: r1 * 16 + 4 });
    documentTarget.dispatch('mouseup', {});
  }

  const click = (canvas: ReturnType<typeof target>, detail: number, col: number, row: number) =>
    canvas.dispatch('click', { detail, offsetX: col * 8 + 1, offsetY: row * 16 + 4 });

  test('a drag backwards selects the same text as forwards', () => {
    const t = ghostty.createTerminal(20, 4);
    t.write('hello world\r\nsecond line');
    const { m, canvas } = manager(t);
    drag(canvas, 5, 1, 6, 0);
    expect(m.getSelection()).toBe('world\nsecond');
    expect(m.getSelectionRange()).toEqual({ startCol: 6, startRow: 0, endCol: 5, endRow: 1 });
    t.free();
  });

  test('a drag while scrolled selects scrollback rows, which stay selected at the bottom', () => {
    const t = ghostty.createTerminal(10, 2);
    t.write('one\r\ntwo\r\nthree\r\nfour');
    let viewportY = 2;
    const { m, canvas } = manager(t, () => viewportY);
    drag(canvas, 0, 0, 4, 1);
    expect(m.getSelection()).toBe('one\ntwo');
    viewportY = 0;
    expect(m.getSelection()).toBe('one\ntwo');
    expect(m.getSelectionRange()).toEqual({ startCol: 0, startRow: -2, endCol: 4, endRow: -1 });
    t.free();
  });

  test('a selection keeps its text while output arrives and scrolls it into history', () => {
    const t = ghostty.createTerminal(10, 3);
    t.write('keep me\r\n');
    const { m, canvas } = manager(t);
    drag(canvas, 0, 0, 6, 0);
    t.write('a\r\nb\r\nc\r\nd');
    expect(t.getScrollbackLength()).toBe(2);
    expect(m.getSelection()).toBe('keep me');
    expect(m.getSelectionRange()).toEqual({ startCol: 0, startRow: -2, endCol: 6, endRow: -2 });
    t.free();
  });

  test('a double click selects a word with path and address characters', () => {
    const t = ghostty.createTerminal(70, 2);
    t.write('ls /usr/local/bin/foo.txt a@b.c x+y ~/q "quoted" (paren) $HOME');
    const { m, canvas } = manager(t);
    const word = (col: number) => {
      click(canvas, 2, col, 0);
      return m.getSelection();
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
    const { m, canvas } = manager(t);
    click(canvas, 2, 15, 0);
    expect(m.hasSelection()).toBe(false);
    expect(writes).toEqual([]);
    t.free();
  });

  test('a triple click selects the line without trailing spaces; an empty line selects nothing', () => {
    const t = ghostty.createTerminal(20, 3);
    t.write('one two   \r\n\r\nthree');
    const { m, canvas } = manager(t);
    click(canvas, 3, 15, 1);
    expect(m.hasSelection()).toBe(false);
    click(canvas, 3, 15, 0);
    expect(m.getSelection()).toBe('one two');
    click(canvas, 3, 0, 2);
    expect(m.getSelection()).toBe('three');
    t.free();
  });

  test('a triple click in scrollback selects that line', () => {
    const t = ghostty.createTerminal(10, 2);
    t.write('first\r\nsecond\r\nthird');
    const { m, canvas } = manager(t, () => 1);
    click(canvas, 3, 2, 0);
    expect(m.getSelection()).toBe('first');
    t.free();
  });

  test('a triple click with Ctrl or Cmd selects the command output; nothing outside it', () => {
    const t = ghostty.createTerminal(20, 6);
    t.write('\x1b]133;A\x07$ \x1b]133;B\x07ls\r\n\x1b]133;C\x07a.txt\r\nb.txt\r\n');
    t.write('\x1b]133;D;0\x07\x1b]133;A\x07$ ');
    const { m, canvas } = manager(t);
    const output = (row: number, mods: object) =>
      canvas.dispatch('click', { detail: 3, offsetX: 1, offsetY: row * 16 + 4, ...mods });
    output(2, { ctrlKey: true });
    expect(m.getSelection()).toBe('a.txt\nb.txt');
    m.clearSelection();
    output(1, { metaKey: true });
    expect(m.getSelection()).toBe('a.txt\nb.txt');
    output(1, {});
    expect(m.getSelection()).toBe('a.txt');
    m.clearSelection();
    output(3, { ctrlKey: true });
    expect(m.hasSelection()).toBe(false);
    t.free();
  });

  // Ghostty's selection rules (ADR 050)

  test('a selection across a soft wrap copies one line; a hard newline stays', () => {
    const t = ghostty.createTerminal(10, 4);
    t.write('0123456789abcdef\r\nnext');
    const { m, canvas } = manager(t);
    drag(canvas, 0, 0, 3, 2);
    expect(m.getSelection()).toBe('0123456789abcdef\nnext');
    t.free();
  });

  test('a double click selects a word that wraps onto the next row', () => {
    const t = ghostty.createTerminal(10, 3);
    t.write('cd /usr/local/bin');
    const { m, canvas } = manager(t);
    click(canvas, 2, 1, 1);
    expect(m.getSelection()).toBe('/usr/local/bin');
    expect(m.getSelectionRange()).toEqual({ startCol: 3, startRow: 0, endCol: 6, endRow: 1 });
    t.free();
  });

  test("a double click selects a URL query and non-ASCII words by Ghostty's word characters", () => {
    const t = ghostty.createTerminal(40, 2);
    t.write('see //x.io/a?b=c&d#e or café 中文字');
    const { m, canvas } = manager(t);
    click(canvas, 2, 8, 0);
    expect(m.getSelection()).toBe('//x.io/a?b=c&d#e');
    click(canvas, 2, 24, 0);
    expect(m.getSelection()).toBe('café');
    click(canvas, 2, 30, 0);
    expect(m.getSelection()).toBe('中文字');
    t.free();
  });

  test('a triple click selects a soft-wrapped line whole, without its indent', () => {
    const t = ghostty.createTerminal(8, 3);
    t.write('  wrapped line\r\nx');
    const { m, canvas } = manager(t);
    click(canvas, 3, 0, 1);
    expect(m.getSelection()).toBe('wrapped line');
    expect(m.getSelectionRange()).toEqual({ startCol: 2, startRow: 0, endCol: 5, endRow: 1 });
    t.free();
  });
});
