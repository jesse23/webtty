import { describe, expect, test } from 'bun:test';
import {
  cursorCellOffset,
  decscusrShape,
  deviceCellPixels,
  mouseCursorFor,
  scanDecscusr,
  Terminal,
} from './ghostty-web/terminal';
import type { GhosttyTerminalConfig, ILink } from './ghostty-web/types';

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
