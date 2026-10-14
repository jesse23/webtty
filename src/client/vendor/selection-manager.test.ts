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
