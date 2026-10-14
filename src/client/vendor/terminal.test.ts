import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import { InputHandler } from './ghostty-web/input-handler';
import { LinkDetector } from './ghostty-web/link-detector';
import { OSC8LinkProvider } from './ghostty-web/providers/osc8-link-provider';
import {
  cursorCellOffset,
  deviceCellPixels,
  mouseCursorFor,
  mouseReportText,
  mouseSurface,
  Terminal,
} from './ghostty-web/terminal';
import type { GhosttyTerminalConfig, ILink } from './ghostty-web/types';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

describe('mouseCursorFor', () => {
  const link: ILink = {
    text: 'https://example.com',
    range: { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } },
    activate: () => {},
  };

  test('uses the default arrow when no link is hovered', () => {
    expect(mouseCursorFor(undefined)).toBe('default');
  });

  test('uses the pointer over a link', () => {
    expect(mouseCursorFor(link)).toBe('pointer');
  });
});

describe('cursorCellOffset', () => {
  const grid = { cols: 80, rows: 24 };
  const cell = { width: 9, height: 18 };
  const canvas = { left: 0, top: 0 };

  test('puts the spot at the cursor cell', () => {
    expect(cursorCellOffset({ x: 10, y: 5 }, 0, grid, cell, canvas)).toEqual({
      left: 90,
      top: 90,
    });
  });

  test('offsets by the canvas position inside the padding', () => {
    expect(cursorCellOffset({ x: 0, y: 0 }, 0, grid, cell, { left: 12, top: 8 })).toEqual({
      left: 12,
      top: 8,
    });
  });

  test('moves down with the scrollback offset', () => {
    expect(cursorCellOffset({ x: 0, y: 5 }, 3, grid, cell, canvas).top).toBe(8 * 18);
  });

  test('stays on the last row once the cursor scrolls out of view', () => {
    expect(cursorCellOffset({ x: 0, y: 20 }, 100, grid, cell, canvas).top).toBe(23 * 18);
  });

  test('clamps a pending-wrap cursor to the last column', () => {
    expect(cursorCellOffset({ x: 80, y: 0 }, 0, grid, cell, canvas).left).toBe(79 * 9);
  });
});

describe('deviceCellPixels', () => {
  test('is the CSS cell at the device pixel ratio, in whole pixels', () => {
    expect(deviceCellPixels(9, 2)).toBe(18);
    expect(deviceCellPixels(8.4, 1.25)).toBe(11);
    expect(deviceCellPixels(19.2, 1.5)).toBe(29);
  });

  test('never reports less than one pixel', () => {
    expect(deviceCellPixels(0, 2)).toBe(1);
    expect(deviceCellPixels(0.2, 1)).toBe(1);
  });
});

describe('mouseSurface', () => {
  // A 9.6 x 19.2 px CSS cell at DPR 1.25 is 12 x 24 device pixels.
  const grid = { left: 110, top: 57, cols: 100, rows: 30, cellWidth: 9.6, cellHeight: 19.2 };
  const box = { left: 100, top: 50, right: 110 + 960 + 7, bottom: 57 + 576 + 3 };
  const cellPx = { width: 12, height: 24 };
  const surface = (x: number, y: number) => mouseSurface(x, y, grid, box, cellPx);

  test('is the container in device-pixel cells, the padding around the grid', () => {
    expect(surface(0, 0).geometry).toEqual({
      screenWidth: 13 + 1200 + 9,
      screenHeight: 9 + 720 + 4,
      cellWidth: 12,
      cellHeight: 24,
      paddingTop: 9,
      paddingRight: 9,
      paddingBottom: 4,
      paddingLeft: 13,
    });
  });

  test('puts cell boundaries exactly where the CSS grid has them, at any column', () => {
    // Column 99 (0-based) starts at 110 + 99 * 9.6 = 1060.4 CSS px
    const cell = (x: number) => Math.floor((surface(x, 60).x - 13) / 12);
    expect(cell(1060.3)).toBe(98);
    expect(cell(1060.5)).toBe(99);
    expect(cell(110)).toBe(0);
    const row = (y: number) => Math.floor((surface(120, y).y - 9) / 24);
    expect(row(57 + 29 * 19.2 - 0.1)).toBe(28);
    expect(row(57 + 29 * 19.2 + 0.1)).toBe(29);
  });

  test('positions in the padding fall before or after the grid', () => {
    expect(surface(101, 51).x).toBeLessThan(13);
    expect(surface(101, 51).y).toBeLessThan(9);
    expect(surface(1075, 60).x).toBeGreaterThan(13 + 1200);
  });
});

describe('mouseReportText', () => {
  test('passes a UTF-8 report through as text', () => {
    expect(mouseReportText(new TextEncoder().encode('\x1b[<0;1;1M'))).toBe('\x1b[<0;1;1M');
    expect(mouseReportText(new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xc3, 0xa8, 0x23]))).toBe(
      '\x1b[M è#',
    );
  });

  test('drops a report with raw bytes above 0x7f, which text frames cannot carry', () => {
    expect(mouseReportText(new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0x21]))).toBe('');
  });
});

describe('Terminal wheel in mouse-tracking apps', () => {
  // A 10 px x 20 px CSS cell at DPR 1, the grid at (5, 5) in a container at (0, 0).
  async function wheelTerm(modes: string) {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(40, 10);
    wasmTerm.write(modes);
    const term = new Terminal({ ghostty: {} as never, cols: 40, rows: 10 });
    const internals = term as unknown as {
      wasmTerm: unknown;
      renderer: unknown;
      canvas: unknown;
      element: unknown;
      handleWheel(e: object): void;
    };
    internals.wasmTerm = wasmTerm;
    internals.renderer = {
      getMetrics: () => ({ width: 10, height: 20, baseline: 15 }),
      scrollOffset: 0,
    };
    internals.canvas = { getBoundingClientRect: () => ({ left: 5, top: 5 }) };
    internals.element = {
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 410, bottom: 210 }),
    };
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const wheel = (deltaY: number, clientX: number, clientY: number, mods: object = {}) =>
      internals.handleWheel({
        deltaY,
        deltaMode: 1,
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
        ...mods,
      });
    return { sent, wheel, free: () => wasmTerm.free() };
  }

  test('sends buttons 4/5 at the pointer cell in SGR, with modifiers', async () => {
    const { sent, wheel, free } = await wheelTerm('\x1b[?1000h\x1b[?1006h');
    wheel(-3, 5 + 10 * 6 + 1, 5 + 20 * 3 + 1);
    wheel(3, 5 + 10 * 6 + 1, 5 + 20 * 3 + 1, { altKey: true });
    expect(sent).toEqual(['\x1b[<64;7;4M', '\x1b[<73;7;4M']);
    free();
  });

  test('follows the format: X10 bytes without 1006, nothing in X10 mode 9', async () => {
    const x10 = await wheelTerm('\x1b[?1000h');
    x10.wheel(3, 6, 6);
    expect(x10.sent).toEqual(['\x1b[Ma!!']);
    x10.free();
    const mode9 = await wheelTerm('\x1b[?9h');
    mode9.wheel(3, 6, 6);
    expect(mode9.sent).toEqual([]);
    mode9.free();
  });
});

describe('Terminal scrollback options', () => {
  // The engine config the terminal builds from its options (ADR 046).
  const wasmConfig = (options: object) =>
    (
      new Terminal({ ghostty: {} as never, ...options }) as unknown as {
        buildWasmConfig(): GhosttyTerminalConfig | undefined;
      }
    ).buildWasmConfig();

  test('passes scrollbackLines through to the engine', () => {
    expect(wasmConfig({ scrollbackLines: 10000 })?.scrollbackLines).toBe(10000);
    expect(wasmConfig({ scrollbackLines: 0 })?.scrollbackLines).toBe(0);
  });

  test('leaves it unset when not given', () => {
    expect(wasmConfig({ theme: {} })?.scrollbackLines).toBeUndefined();
  });

  test('leaves unset and invalid colours undefined, so #000000 is black', () => {
    const config = wasmConfig({
      theme: { foreground: '#d4d4d4', background: '#000000', red: 'nope', green: '#0dbc79' },
    });
    expect(config).toMatchObject({ fgColor: 0xd4d4d4, bgColor: 0, cursorColor: undefined });
    expect(config?.palette?.slice(0, 3)).toEqual([undefined, undefined, 0x0dbc79]);
  });
});

describe('Terminal cursor style', () => {
  // The configured shape is the engine's default, which DECSCUSR Ps 0 and RIS restore;
  // the output is not scanned (ADR 049).
  test('passes cursorStyle and cursorBlink to the engine as its default', () => {
    const term = new Terminal({ ghostty: {} as never, cursorStyle: 'bar', cursorBlink: true });
    const config = (
      term as unknown as { buildWasmConfig(): GhosttyTerminalConfig }
    ).buildWasmConfig();
    expect(config).toMatchObject({ cursorStyle: 'bar', cursorBlink: true });
  });

  test('a cursor option change sets the engine default', () => {
    const term = new Terminal({ ghostty: {} as never });
    const defaults: unknown[] = [];
    const internals = term as unknown as { isOpen: boolean; wasmTerm: object };
    internals.wasmTerm = {
      setDefaultCursor: (style: string, blink: boolean) => defaults.push([style, blink]),
    };
    internals.isOpen = true;
    term.options.cursorStyle = 'underline';
    term.options.cursorBlink = true;
    expect(defaults).toEqual([
      ['underline', false],
      ['underline', true],
    ]);
  });
});

describe('Terminal paste', () => {
  // Pastes are encoded by ghostty_terminal_paste and leave through onData (ADR 049).
  async function pasteTerm(options: object = {}) {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(40, 10);
    const term = new Terminal({ ghostty: {} as never, ...options });
    const internals = term as unknown as { isOpen: boolean; wasmTerm: unknown };
    internals.wasmTerm = wasmTerm;
    internals.isOpen = true;
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    return { term, wasmTerm, sent };
  }

  test('sends the text as Ghostty encodes it for the mode', async () => {
    const { term, wasmTerm, sent } = await pasteTerm();
    term.paste('one\ntwo\x1b');
    wasmTerm.write('\x1b[?2004h');
    term.paste('three');
    expect(sent).toEqual(['one\rtwo ', '\x1b[200~three\x1b[201~']);
    wasmTerm.free();
  });

  test('sends nothing with stdin disabled', async () => {
    const { term, wasmTerm, sent } = await pasteTerm({ disableStdin: true });
    term.paste('hello');
    expect(sent).toEqual([]);
    expect(wasmTerm.hasResponse()).toBe(false);
    wasmTerm.free();
  });
});

describe('Terminal clearScreen', () => {
  // Ghostty's clear_screen with what libghostty-vt has: the erasing is written to the
  // terminal, and only FF, at a prompt, goes to the app (ADR 054).
  async function clearTerm(options: object = {}) {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(20, 5);
    const term = new Terminal({ ghostty: {} as never, ...options });
    const internals = term as unknown as { isOpen: boolean; wasmTerm: unknown };
    internals.wasmTerm = wasmTerm;
    internals.isOpen = true;
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const text = (cells: { codepoint: number }[] | null) =>
      (cells ?? [])
        .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
        .join('')
        .trimEnd();
    const screen = () => Array.from({ length: 5 }, (_, y) => text(wasmTerm.getLine(y)));
    const scrollback = () =>
      Array.from({ length: wasmTerm.getScrollbackLength() }, (_, i) =>
        text(wasmTerm.getScrollbackLine(i)),
      );
    const fill = () => {
      for (let i = 0; i < 8; i++) term.write(`line${i}\r\n`);
    };
    return { term, wasmTerm, sent, screen, scrollback, fill };
  }

  test('away from a prompt, drops the scrollback and the rows above the cursor', async () => {
    const { term, wasmTerm, sent, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('$ make');
    expect(term.clearScreen()).toBe(true);
    expect(screen()).toEqual(['$ make', '', '', '', '']);
    expect(scrollback()).toEqual([]);
    expect(wasmTerm.getCursor()).toMatchObject({ x: 6, y: 0 });
    // Output in progress carries on below the cursor's row
    term.write('\r\nok');
    expect(screen()).toEqual(['$ make', 'ok', '', '', '']);
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('with the cursor on the top row, drops only the scrollback', async () => {
    const { term, wasmTerm, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('\x1b[H');
    expect(term.clearScreen()).toBe(true);
    expect(screen()).toEqual(['line4', 'line5', 'line6', 'line7', '']);
    expect(scrollback()).toEqual([]);
    wasmTerm.free();
  });

  test('at an OSC 133 prompt, erases everything and sends FF for the shell to redraw', async () => {
    const { term, wasmTerm, sent, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('\x1b]133;A\x07~ > \x1b]133;B\x07ls');
    expect(wasmTerm.cursorAtPrompt()).toBe(true);
    expect(term.clearScreen()).toBe(true);
    expect(screen()).toEqual(['', '', '', '', '']);
    expect(scrollback()).toEqual([]);
    expect(sent).toEqual(['\x0c']);
    wasmTerm.free();
  });

  test('sends no FF with stdin disabled', async () => {
    const { term, wasmTerm, sent } = await clearTerm({ disableStdin: true });
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07');
    expect(term.clearScreen()).toBe(true);
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('does nothing on the alternate screen, where the key goes to the app', async () => {
    const { term, wasmTerm, sent, screen, fill } = await clearTerm();
    fill();
    term.write('\x1b[?1049h\x1b[Hvim');
    expect(term.clearScreen()).toBe(false);
    expect(screen()[0]).toBe('vim');
    term.write('\x1b[?1049l');
    expect(wasmTerm.getScrollbackLength()).toBe(4);
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('clears the selection', async () => {
    const { term, wasmTerm, fill } = await clearTerm();
    fill();
    let cleared = 0;
    (term as unknown as { selectionManager: object }).selectionManager = {
      clearSelection: () => cleared++,
    };
    term.clearScreen();
    expect(cleared).toBe(1);
    wasmTerm.free();
  });

  test('waits for a sequence cut off by the end of a write, and clears where it ends', async () => {
    const { term, wasmTerm, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('build \x1b[3');
    expect(term.clearScreen()).toBe(true);
    expect(scrollback().length).toBeGreaterThan(0);
    // The rest of the SGR finishes it; the clear goes in there, before the text after it
    term.write('1mred\r\nnext');
    expect(screen()).toEqual(['build red', 'next', '', '', '']);
    expect(scrollback()).toEqual([]);
    const red = wasmTerm.getLine(0)?.[6];
    expect(red && red.fg_r > red.fg_g).toBe(true);
    wasmTerm.free();
  });

  test('a cut-off OSC keeps its effect', async () => {
    const { term, wasmTerm, scrollback, fill } = await clearTerm();
    fill();
    const titles: string[] = [];
    term.onTitleChange((t) => titles.push(t));
    term.write('\x1b]2;bui');
    term.clearScreen();
    term.write('ld\x07');
    expect(titles).toEqual(['build']);
    expect(scrollback()).toEqual([]);
    wasmTerm.free();
  });

  test('a write that ends inside another sequence still gets the clear', async () => {
    const { term, wasmTerm, screen, scrollback, fill } = await clearTerm();
    fill();
    term.write('a\x1b[3');
    term.clearScreen();
    term.write('1mb\x1b[0');
    expect(scrollback()).toEqual([]);
    term.write('mc');
    expect(screen()).toEqual(['abc', '', '', '', '']);
    wasmTerm.free();
  });

  test('a waiting clear at a prompt checks the prompt and sends FF once it goes in', async () => {
    const { term, wasmTerm, sent, screen, fill } = await clearTerm();
    fill();
    term.write('\x1b]133;A\x07$ \x1b]133;B\x07\x1b[3');
    term.clearScreen();
    expect(sent).toEqual([]);
    term.write('1m');
    expect(screen()).toEqual(['', '', '', '', '']);
    expect(sent).toEqual(['\x0c']);
    wasmTerm.free();
  });

  test('a waiting clear is dropped if the screen has turned alternate', async () => {
    const { term, wasmTerm, scrollback, fill } = await clearTerm();
    fill();
    term.write('\x1b[?1049');
    term.clearScreen();
    term.write('h\x1b[Hvim');
    term.write('\x1b[?1049l');
    expect(scrollback().length).toBeGreaterThan(0);
    wasmTerm.free();
  });
});

describe('Terminal find', () => {
  // Find with libghostty-vt's search, run in the render loop (ADR 055).
  async function findTerm() {
    const ghostty = await Ghostty.load(WASM);
    const term = new Terminal({ ghostty, cols: 20, rows: 4, scrollbackLines: 1000 });
    const highlights: unknown[] = [];
    const renderer = {
      clear: () => {},
      getMetrics: () => ({ width: 8, height: 16, baseline: 12 }),
      devicePixelRatio: 1,
      setSearchHighlights: (h: unknown) => highlights.push(h),
      render: () => {},
    };
    const internals = term as unknown as {
      isOpen: boolean;
      wasmTerm: ReturnType<typeof ghostty.createTerminal>;
      ghostty: typeof ghostty;
      renderer: typeof renderer;
      showScrollbar: () => void;
      stepFind: (now: number) => void;
    };
    internals.wasmTerm = ghostty.createTerminal(20, 4, { scrollbackLines: 1000 });
    internals.ghostty = ghostty;
    internals.renderer = renderer;
    internals.isOpen = true;
    internals.showScrollbar = () => {};
    let now = 0;
    /** Render-loop frames: the search steps before each. */
    const frames = (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += 1000;
        internals.stepFind(now);
      }
    };
    const states: unknown[] = [];
    term.onFindChange((s) => states.push(s));
    const last = () =>
      highlights[highlights.length - 1] as {
        matches: Int32Array;
        selected: unknown;
      } | null;
    return { term, internals, frames, states, last };
  }

  test('finds in the render loop, reports the count, and highlights every match', async () => {
    const { term, internals, frames, states, last } = await findTerm();
    for (let i = 0; i < 20; i++) term.write(i % 5 === 0 ? `Error ${i}\r\n` : `ok ${i}\r\n`);
    expect(term.finding).toBe(false);
    term.find('error');
    expect(term.finding).toBe(true);
    frames(3);
    expect(states[states.length - 1]).toEqual({ total: 4, selected: null });
    expect(last()?.matches.length).toBe(16);
    expect(last()?.selected).toBeNull();
    internals.wasmTerm.free();
  });

  test('next scrolls to a match out of view, its first row at the top, and wraps', async () => {
    const { term, internals, frames, states } = await findTerm();
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.write('needle');
    term.find('needle');
    frames(2);
    const sb = term.getScrollbackLength();
    // The newest match is on screen: no scroll
    expect(term.findNext()).toBe(true);
    expect(term.viewportY).toBe(0);
    expect(states[states.length - 1]).toEqual({ total: 2, selected: 0 });
    // The oldest is the first scrollback row
    term.findNext();
    expect(term.viewportY).toBe(sb);
    expect(states[states.length - 1]).toEqual({ total: 2, selected: 1 });
    term.findPrevious();
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('with no search open, next and previous are not performed', async () => {
    const { term, internals } = await findTerm();
    expect(term.findNext()).toBe(false);
    expect(term.findPrevious()).toBe(false);
    internals.wasmTerm.free();
  });

  test('output keeps a scrolled view on its rows while a match is selected', async () => {
    const { term, internals, frames } = await findTerm();
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('needle');
    frames(2);
    term.findNext();
    const view = term.viewportY;
    expect(view).toBeGreaterThan(0);
    term.write('more\r\nmore\r\nmore\r\n');
    expect(term.viewportY).toBe(view);
    frames();
    expect(term.viewportY).toBe(view + 3);
    // The view still starts at the match
    expect(term.getScrollbackLength() - term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('without a selected match, output scrolls to the bottom as before', async () => {
    const { term, internals, frames } = await findTerm();
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('line');
    frames(2);
    term.scrollToLine(5);
    term.write('x\r\n');
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('a key or a paste scrolls a view on a selected match to the bottom', async () => {
    // Ghostty's `scroll-to-bottom = keystroke` (ADR 055)
    const { term, internals, frames } = await findTerm();
    const input = term as unknown as { handleInput: (data: string, mouse?: boolean) => void };
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('needle');
    frames(2);
    term.findNext();
    const view = term.viewportY;
    expect(view).toBeGreaterThan(0);
    // A mouse report leaves the view alone
    input.handleInput('\x1b[M !!', true);
    expect(term.viewportY).toBe(view);
    input.handleInput('l');
    expect(term.viewportY).toBe(0);
    // and the echo is followed
    term.write('l\r\n');
    frames();
    expect(term.viewportY).toBe(0);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    term.paste('ls');
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('output that switches to the alternate screen scrolls to the bottom', async () => {
    const { term, internals, frames } = await findTerm();
    term.write('needle\r\n');
    for (let i = 0; i < 20; i++) term.write(`line ${i}\r\n`);
    term.find('needle');
    frames(2);
    term.findNext();
    expect(term.viewportY).toBeGreaterThan(0);
    term.write('\x1b[?1049hpager');
    expect(term.viewportY).toBe(0);
    frames();
    expect(term.viewportY).toBe(0);
    internals.wasmTerm.free();
  });

  test('ending the search clears the highlights and the count', async () => {
    const { term, internals, frames, states, last } = await findTerm();
    term.write('abc abc');
    term.find('abc');
    frames();
    term.findNext();
    frames();
    term.endFind();
    expect(term.finding).toBe(false);
    expect(last()).toBeNull();
    expect(states[states.length - 1]).toEqual({ total: 0, selected: null });
    frames();
    expect(last()).toBeNull();
    internals.wasmTerm.free();
  });

  test('a reset (reconnect) searches the new engine', async () => {
    const { term, internals, frames, states } = await findTerm();
    term.write('abc');
    term.find('abc');
    frames();
    expect(states[states.length - 1]).toEqual({ total: 1, selected: null });
    term.reset();
    frames();
    expect(states[states.length - 1]).toEqual({ total: 0, selected: null });
    term.write('abc abc');
    frames();
    expect(states[states.length - 1]).toEqual({ total: 2, selected: null });
    internals.wasmTerm.free();
  });
});

describe('Terminal bell and title', () => {
  // Bell and title come from the engine's readEffects, not from scanning the output
  // (ADR 047).
  test('a bell and a title reported by readEffects reach onBell and onTitleChange', () => {
    const term = new Terminal({ ghostty: {} as never });
    let effects: { bell: boolean; title: string | null; clipboard: string | null } = {
      bell: true,
      title: 'vim',
      clipboard: null,
    };
    (term as unknown as { wasmTerm: object }).wasmTerm = {
      write: () => {},
      hasResponse: () => false,
      readResponse: () => null,
      getMode: () => false,
      readEffects: () => {
        const e = effects;
        effects = { bell: false, title: null, clipboard: null };
        return e;
      },
    };
    const write = (data: string) =>
      (term as unknown as { writeInternal(data: string): void }).writeInternal(data);
    let bells = 0;
    const titles: string[] = [];
    term.onBell(() => bells++);
    term.onTitleChange((title) => titles.push(title));

    write('\x1b]2;vim\x07\x07');
    expect(bells).toBe(1);
    expect(titles).toEqual(['vim']);
    // A BEL or OSC 2 the engine did not report fires nothing.
    write('\x07\x1b]2;other\x07');
    expect(bells).toBe(1);
    expect(titles).toEqual(['vim']);
  });
});

describe('Terminal focus reports', () => {
  // Mode 1004 reports are encoded by Ghostty and sent as Ghostty's Surface sends them:
  // on a focus change while the mode is on, and the current state when it is set
  // (ADR 053).
  async function focusTerm(options: object = {}) {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(20, 2);
    const term = new Terminal({ ghostty: {} as never, ...options });
    const element = { contains: (node: unknown) => node === inside };
    const inside = {};
    const internals = term as unknown as {
      isOpen: boolean;
      wasmTerm: unknown;
      element: unknown;
      handleFocusGained(): void;
      handleFocusLost(e: { relatedTarget: unknown }): void;
      writeInternal(data: string): void;
    };
    internals.wasmTerm = wasmTerm;
    internals.isOpen = true;
    internals.element = element;
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    return {
      term,
      wasmTerm,
      sent,
      write: (data: string) => internals.writeInternal(data),
      focusIn: () => internals.handleFocusGained(),
      focusOut: (relatedTarget: unknown = null) => internals.handleFocusLost({ relatedTarget }),
      inside,
    };
  }

  test('sends nothing on focus changes while mode 1004 is off', async () => {
    const { wasmTerm, sent, focusIn, focusOut } = await focusTerm();
    focusIn();
    focusOut();
    expect(sent).toEqual([]);
    wasmTerm.free();
  });

  test('sends the current focus when the app sets the mode, then each change', async () => {
    const { wasmTerm, sent, write, focusIn, focusOut } = await focusTerm();
    focusIn();
    write('\x1b[?1004h');
    expect(sent).toEqual(['\x1b[I']);
    focusOut();
    focusIn();
    expect(sent).toEqual(['\x1b[I', '\x1b[O', '\x1b[I']);
    // Setting it again while it is on, or other output, sends nothing.
    write('\x1b[?1004hplain');
    expect(sent).toHaveLength(3);
    write('\x1b[?1004l');
    focusOut();
    expect(sent).toHaveLength(3);
    // Set again while unfocused: the report says so.
    write('\x1b[?1004h');
    expect(sent).toEqual(['\x1b[I', '\x1b[O', '\x1b[I', '\x1b[O']);
    wasmTerm.free();
  });

  test('a move inside the terminal, or a repeated event, is not a change', async () => {
    const { wasmTerm, sent, write, focusIn, focusOut, inside } = await focusTerm();
    focusIn();
    write('\x1b[?1004h');
    // The container passing focus on to the textarea: out with an inside target, in.
    focusOut(inside);
    focusIn();
    focusIn();
    expect(sent).toEqual(['\x1b[I']);
    focusOut();
    focusOut();
    expect(sent).toEqual(['\x1b[I', '\x1b[O']);
    wasmTerm.free();
  });

  test('resyncFocus sends the current focus while the mode is on, for a new connection', async () => {
    const { term, wasmTerm, sent, write, focusIn, focusOut } = await focusTerm();
    focusIn();
    term.resyncFocus();
    expect(sent).toEqual([]);
    write('\x1b[?1004h');
    // The socket goes down: this report is dropped on the way to the app.
    focusOut();
    sent.length = 0;
    // The replay of a reconnect leaves the mode on, which sends nothing: the resync does.
    write('\x1b[?1004h');
    expect(sent).toEqual([]);
    term.resyncFocus();
    expect(sent).toEqual(['\x1b[O']);
    wasmTerm.free();
  });

  test('sends nothing with stdin disabled', async () => {
    const { wasmTerm, sent, write, focusIn, focusOut } = await focusTerm({ disableStdin: true });
    write('\x1b[?1004h');
    focusIn();
    focusOut();
    expect(sent).toEqual([]);
    wasmTerm.free();
  });
});

describe('Terminal clipboard writes', () => {
  // Program clipboard writes come from the engine's readEffects and reach the embedder
  // through onClipboardWrite (ADR 052).
  test('OSC 52 output fires onClipboardWrite with the decoded text, once', async () => {
    const ghostty = await Ghostty.load(WASM);
    const term = new Terminal({ ghostty: {} as never });
    (term as unknown as { wasmTerm: unknown }).wasmTerm = ghostty.createTerminal(20, 2);
    const write = (data: string) =>
      (term as unknown as { writeInternal(data: string): void }).writeInternal(data);
    const copied: string[] = [];
    term.onClipboardWrite((text) => copied.push(text));

    write(`\x1b]52;c;${Buffer.from('héllo 中文').toString('base64')}\x07`);
    expect(copied).toEqual(['héllo 中文']);
    write('plain output');
    write('\x1b]52;c;\x07');
    expect(copied).toEqual(['héllo 中文', '']);
  });

  test('dispose drops onClipboardWrite listeners', () => {
    const term = new Terminal({ ghostty: {} as never });
    const copied: string[] = [];
    term.onClipboardWrite((text) => copied.push(text));
    term.dispose();
    (
      term as unknown as { clipboardWriteEmitter: { fire(t: string): void } }
    ).clipboardWriteEmitter.fire('x');
    expect(copied).toEqual([]);
  });

  test('passes clipboardWrite to the engine, on by default', () => {
    const wasmConfig = (options: object) =>
      (
        new Terminal({ ghostty: {} as never, ...options }) as unknown as {
          buildWasmConfig(): GhosttyTerminalConfig;
        }
      ).buildWasmConfig();
    expect(wasmConfig({}).clipboardWrite).toBe(true);
    expect(wasmConfig({ clipboardWrite: false }).clipboardWrite).toBe(false);
  });
});

describe('Terminal input and the selection', () => {
  // Keys and text clear the selection; mouse reports leave it, so a Shift selection in an
  // app with any-motion mode 1003 survives the next hover or click (ADR 051).
  test('a mouse report keeps the selection, a key clears it', async () => {
    const ghostty = await Ghostty.load(WASM);
    const term = new Terminal({ ghostty: {} as never });
    const internals = term as unknown as { selectionManager: unknown };
    let selection = 'hello';
    internals.selectionManager = {
      clearSelection: () => {
        selection = '';
      },
    };
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    type Listener = (e: object) => void;
    const listeners = new Map<string, Listener[]>();
    const container = {
      ownerDocument: undefined,
      contains: () => true,
      addEventListener: (type: string, l: Listener) =>
        listeners.set(type, [...(listeners.get(type) ?? []), l]),
      removeEventListener: () => {},
    };
    const fire = (type: string, e: object) => {
      for (const l of listeners.get(type) ?? []) l(e);
    };
    const handler = new InputHandler(
      ghostty,
      container as unknown as HTMLElement,
      (term as unknown as { handleInput(d: string, m?: boolean): void }).handleInput,
      undefined,
      undefined,
      undefined,
      { hasMouseTracking: () => true, encode: () => '\x1b[<35;4;4M' },
    );
    const mods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    fire('mousemove', { ...mods, target: container, buttons: 0, clientX: 1, clientY: 1 });
    fire('mousedown', {
      ...mods,
      target: container,
      button: 0,
      buttons: 1,
      clientX: 1,
      clientY: 1,
    });
    expect(sent.length).toBe(2);
    expect(selection).toBe('hello');
    fire('keydown', {
      ...mods,
      key: 'a',
      code: 'KeyA',
      isComposing: false,
      preventDefault: () => {},
    });
    expect(sent[2]).toBe('a');
    expect(selection).toBe('');
    handler.dispose();
  });
});

describe('Terminal link hover', () => {
  // The engine's hyperlink_id is a 1-bit "has a link" flag, so every OSC 8 cell carries
  // the same value: the hover is the hovered link's range, never an id.
  test('hovering an OSC 8 link gives the renderer that link range only', async () => {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(30, 4);
    wasmTerm.write('\x1b]8;;https://a/\x1b\\first\x1b]8;;\x1b\\\r\n');
    wasmTerm.write('xx \x1b]8;;https://b/\x1b\\second\x1b]8;;\x1b\\');
    const term = new Terminal({ ghostty: {} as never, cols: 30, rows: 4 });
    const calls: [string, unknown][] = [];
    const renderer = new Proxy(
      { charWidth: 8, charHeight: 16, scrollOffset: 0 },
      {
        get: (t, k) =>
          k in t ? t[k as keyof typeof t] : (arg: unknown) => calls.push([String(k), arg]),
      },
    );
    const internals = term as unknown as {
      wasmTerm: unknown;
      renderer: unknown;
      canvas: unknown;
      linkDetector: LinkDetector;
      processMouseMove(e: { clientX: number; clientY: number }): void;
    };
    internals.wasmTerm = wasmTerm;
    internals.renderer = renderer;
    internals.canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }), style: {} };
    internals.linkDetector = new LinkDetector(term);
    internals.linkDetector.registerProvider(new OSC8LinkProvider(term));

    // Over "second", on row 1
    internals.processMouseMove({ clientX: 5 * 8 + 1, clientY: 16 + 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([['setHoveredLinkRange', { startX: 3, startY: 1, endX: 8, endY: 1 }]]);
    wasmTerm.free();
  });
});

describe('Terminal wheel events', () => {
  // A cancelled wheel event makes Chrome hold the gesture's next one until the page has
  // handled it: only zooming (pinch, ctrl+wheel) is cancelled (ADR 045).
  const wheel = (ctrlKey: boolean) => {
    let cancelled = false;
    const e = {
      ctrlKey,
      deltaX: 0,
      deltaY: 10,
      deltaMode: 0,
      preventDefault: () => {
        cancelled = true;
      },
      stopPropagation: () => {},
    };
    const term = new Terminal({ ghostty: {} as never }) as unknown as {
      handleWheel: (e: unknown) => void;
    };
    term.handleWheel(e);
    return cancelled;
  };

  test('a scroll is not cancelled', () => {
    expect(wheel(false)).toBe(false);
  });

  test('pinch and ctrl+wheel are cancelled, so the page does not zoom', () => {
    expect(wheel(true)).toBe(true);
  });
});

describe('Terminal right-click', () => {
  // Every contextmenu goes through one handler: the app's right button cancels the menu,
  // and otherwise rightClickBehavior decides (ADR 051).
  async function setup(rightClickBehavior: 'contextMenu' | 'copyPaste' | 'paste' | 'none') {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(20, 2);
    wasmTerm.write('hello');
    const term = new Terminal({ ghostty: {} as never, rightClickBehavior });
    const calls: string[] = [];
    let selection = '';
    const internals = term as unknown as {
      wasmTerm: unknown;
      selectionManager: unknown;
      handleMenuPress(e: object): void;
      handleMenuKey(): void;
      handleContextMenu(e: object): void;
    };
    internals.wasmTerm = wasmTerm;
    internals.selectionManager = {
      getSelection: () => selection,
      copySelection: () => {
        calls.push(`copy ${selection}`);
        return true;
      },
      clearSelection: () => {
        calls.push('clear');
        selection = '';
      },
      prepareContextMenu: () => calls.push('menu'),
    };
    term.onPasteRequest(() => calls.push('paste'));
    /** A right-click (press, then menu), or a keyboard menu; whether the menu was cancelled. */
    const menu = (opts: { shiftKey?: boolean; keyboard?: boolean } = {}) => {
      let cancelled = false;
      if (opts.keyboard) internals.handleMenuKey();
      else internals.handleMenuPress({ button: 2, ctrlKey: false });
      internals.handleContextMenu({
        button: opts.keyboard ? 0 : 2,
        shiftKey: opts.shiftKey ?? false,
        clientX: 1,
        clientY: 1,
        preventDefault: () => {
          cancelled = true;
        },
      });
      return cancelled;
    };
    return {
      menu,
      calls,
      select: (text: string) => {
        selection = text;
      },
      track: (on: boolean) => wasmTerm.write(on ? '\x1b[?1000h' : '\x1b[?1000l'),
      free: () => wasmTerm.free(),
    };
  }

  test('contextMenu shows the menu; while the app tracks the mouse only Shift or the keyboard do', async () => {
    const t = await setup('contextMenu');
    expect(t.menu()).toBe(false);
    t.track(true);
    expect(t.menu()).toBe(true);
    expect(t.menu({ shiftKey: true })).toBe(false);
    expect(t.menu({ keyboard: true })).toBe(false);
    expect(t.calls).toEqual(['menu', 'menu', 'menu']);
    t.free();
  });

  test('copyPaste copies and clears a selection, or shows the menu without one', async () => {
    const t = await setup('copyPaste');
    expect(t.menu()).toBe(false);
    t.select('hello');
    expect(t.menu()).toBe(true);
    expect(t.calls).toEqual(['menu', 'copy hello', 'clear']);
    t.track(true);
    t.select('hello');
    expect(t.menu()).toBe(true);
    expect(t.calls.length).toBe(3);
    t.free();
  });

  test('paste asks for a paste with no menu; none does nothing', async () => {
    const p = await setup('paste');
    expect(p.menu()).toBe(true);
    p.track(true);
    expect(p.menu()).toBe(true);
    expect(p.menu({ shiftKey: true })).toBe(true);
    expect(p.calls).toEqual(['paste', 'paste']);
    p.free();
    const n = await setup('none');
    expect(n.menu()).toBe(true);
    expect(n.menu({ keyboard: true })).toBe(true);
    expect(n.calls).toEqual([]);
    n.free();
  });

  test('defaults to contextMenu', () => {
    expect(new Terminal({ ghostty: {} as never }).options.rightClickBehavior).toBe('contextMenu');
  });
});
