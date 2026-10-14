import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, type GhosttyTerminal } from './ghostty-web/ghostty';
import type { CanvasRenderer } from './ghostty-web/renderer';
import { SelectionManager } from './ghostty-web/selection-manager';
import type { Terminal } from './ghostty-web/terminal';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
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

  test('nothing is copied or built with copyOnSelect off, but the change is reported', () => {
    const { canvas, builds, changes } = manager(false);
    drag(canvas);
    canvas.dispatch('click', { detail: 2, offsetX: 8 * 7, offsetY: 4 });
    canvas.dispatch('click', { detail: 3, offsetX: 8, offsetY: 20 });
    expect(writes).toEqual([]);
    expect(builds()).toBe(0);
    expect(changes()).toBe(3);
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

  test('copies no space for a spacer at the last column', () => {
    // A wide character that does not fit wraps, leaving a spacer at the last column
    const wrapped = ghostty.createTerminal(5, 4);
    wrapped.write('abcd中ef');
    expect(selected(wrapped, [0, 0], [4, 1])).toBe('abcd\n中ef');
    expect(selected(wrapped, [2, 0], [4, 0])).toBe('cd');
    wrapped.free();
    // A wide character ending at the last column
    const fits = ghostty.createTerminal(6, 4);
    fits.write('abcd中ef');
    expect(selected(fits, [3, 0], [1, 1])).toBe('d中\nef');
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
