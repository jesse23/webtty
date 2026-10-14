import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import { LinkDetector } from './ghostty-web/link-detector';
import { OSC8LinkProvider } from './ghostty-web/providers/osc8-link-provider';
import {
  cursorCellOffset,
  decscusrShape,
  deviceCellPixels,
  mouseCursorFor,
  mouseReportText,
  mouseSurface,
  scanDecscusr,
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

describe('decscusrShape', () => {
  test('Ps 0 clears the app shape so the configured one shows', () => {
    expect(decscusrShape(0)).toBeUndefined();
  });

  test('Ps 1 — blinking block', () => {
    expect(decscusrShape(1)).toEqual({ style: 'block', blink: true });
  });

  test('Ps 2 — steady block', () => {
    expect(decscusrShape(2)).toEqual({ style: 'block', blink: false });
  });

  test('Ps 3 — blinking underline', () => {
    expect(decscusrShape(3)).toEqual({ style: 'underline', blink: true });
  });

  test('Ps 4 — steady underline', () => {
    expect(decscusrShape(4)).toEqual({ style: 'underline', blink: false });
  });

  test('Ps 5 — blinking bar', () => {
    expect(decscusrShape(5)).toEqual({ style: 'bar', blink: true });
  });

  test('Ps 6 — steady bar', () => {
    expect(decscusrShape(6)).toEqual({ style: 'bar', blink: false });
  });
});

describe('scanDecscusr', () => {
  test('reads Ps', () => {
    expect(scanDecscusr('\x1b[6 q')).toEqual({ ps: 6, carry: '' });
  });

  test('empty Ps is 0', () => {
    expect(scanDecscusr('\x1b[ q').ps).toBe(0);
  });

  test('no sequence yields no Ps', () => {
    expect(scanDecscusr('hello world')).toEqual({ ps: undefined, carry: '' });
  });

  test('out-of-range Ps is ignored', () => {
    expect(scanDecscusr('\x1b[7 q').ps).toBeUndefined();
    expect(scanDecscusr('\x1b[5 q\x1b[7 q').ps).toBe(5);
  });

  test('last sequence in a chunk wins', () => {
    expect(scanDecscusr('\x1b[2 q some output \x1b[5 q').ps).toBe(5);
  });

  test('finds a sequence embedded in output', () => {
    expect(scanDecscusr('text before\x1b[6 qtext after').ps).toBe(6);
  });

  test('ignores other CSI sequences ending in q', () => {
    expect(scanDecscusr('\x1b[>q\x1b[1q\x1b[0"q').ps).toBeUndefined();
  });

  test('carries a sequence split across chunks', () => {
    for (const [head, tail] of [
      ['ab\x1b', '[6 q'],
      ['ab\x1b[', '6 q'],
      ['ab\x1b[6', ' q'],
      ['ab\x1b[6 ', 'q'],
    ]) {
      const first = scanDecscusr(head);
      expect(first.ps).toBeUndefined();
      expect(first.carry).toBe(head.slice(2));
      expect(scanDecscusr(tail, first.carry)).toEqual({ ps: 6, carry: '' });
    }
  });

  test('carries nothing after a finished sequence or plain text', () => {
    expect(scanDecscusr('\x1b[6 q').carry).toBe('');
    expect(scanDecscusr('\x1b[6m').carry).toBe('');
    expect(scanDecscusr('\x1b[6 x').carry).toBe('');
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

describe('Terminal bell and title', () => {
  // Bell and title come from the engine's readEffects, not from scanning the output
  // (ADR 047).
  test('a bell and a title reported by readEffects reach onBell and onTitleChange', () => {
    const term = new Terminal({ ghostty: {} as never });
    let effects: { bell: boolean; title: string | null } = { bell: true, title: 'vim' };
    (term as unknown as { wasmTerm: object }).wasmTerm = {
      write: () => {},
      hasResponse: () => false,
      readResponse: () => null,
      readEffects: () => {
        const e = effects;
        effects = { bell: false, title: null };
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
