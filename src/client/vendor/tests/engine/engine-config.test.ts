import { beforeAll, describe, expect, test } from 'bun:test';
import {
  configSlots,
  DEFAULT_SCROLLBACK_LINES,
  EngineConfig,
  FALLBACK_BACKGROUND,
  FALLBACK_FOREGROUND,
  SCROLLBACK_CEILING_BYTES,
  writeRgb,
} from '../../ghostty-web/engine/engine-config';
import type { Ghostty, GhosttyTerminal, OfficialTerminal } from '../../ghostty-web/ghostty';
import { bindingContext, freeContext } from '../support/engine-harness';
import { bgRgb, FG, RED, rgb, THEME } from '../support/terminal-text';
import { loadGhostty } from '../support/wasm';

// The terminal config the engine applies (ADR 042, ADR 046, ADR 061): theme colours and
// their fallbacks, the scrollback limit in lines, and the cursor blink kept in mode 12,
// through OfficialTerminal and directly.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('official engine: theme colours', () => {
  test('uses an explicitly black theme background instead of the default', () => {
    const t = term(40, 5, { fgColor: FG, bgColor: 0 });
    t.write('\x1b]11;?\x07');
    expect(t.readResponse()).toBe('\x1b]11;rgb:0000/0000/0000\x07');
    t.free();
  });

  test("sets a black palette entry as black and keeps Ghostty's default for an unset one", () => {
    const fgs = (config: object) => {
      const t = term(10, 3, config);
      t.write('\x1b[30mA\x1b[31mB');
      t.update();
      const line = t.getLine(0) ?? [];
      t.free();
      return [rgb(line[0]), rgb(line[1])];
    };
    const ghosttyBlack = fgs({})[0];
    expect(ghosttyBlack).not.toBe(0);
    expect(fgs({ palette: [0x000000, RED] })).toEqual([0, RED]);
    expect(fgs({ palette: [undefined, RED] })).toEqual([ghosttyBlack, RED]);
  });

  // Ghostty's render state copies the default colours only when both are set, so the
  // binding always sets both, falling back to webtty's default 0xcccccc on black.
  const defaults = (t: GhosttyTerminal) => {
    t.write('\x1b[1;1HA');
    t.update();
    const cell = (t.getLine(0) ?? [])[0];
    t.readResponse();
    t.write('\x1b]10;?\x07');
    const osc10 = t.readResponse();
    t.write('\x1b]11;?\x07');
    const osc11 = t.readResponse();
    return {
      cellFg: rgb(cell),
      cellBg: bgRgb(cell),
      osc10,
      osc11,
    };
  };

  test('falls back to the default background when only the foreground is given', () => {
    for (const config of [{ fgColor: FG }, { fgColor: FG, bgColor: undefined }]) {
      const t = term(10, 3, config);
      expect(defaults(t)).toEqual({
        cellFg: FG,
        cellBg: 0,
        osc10: '\x1b]10;rgb:d4d4/d4d4/d4d4\x07',
        osc11: '\x1b]11;rgb:0000/0000/0000\x07',
      });
      t.free();
    }
  });

  test('falls back to the default foreground when only the background is given', () => {
    const t = term(10, 3, { bgColor: 0x202020 });
    expect(defaults(t)).toEqual({
      cellFg: 0xcccccc,
      cellBg: 0x202020,
      osc10: '\x1b]10;rgb:cccc/cccc/cccc\x07',
      osc11: '\x1b]11;rgb:2020/2020/2020\x07',
    });
    t.free();
  });

  test('without theme colours still applies OSC 11 and DECSCNM', () => {
    for (const config of [undefined, { scrollbackLines: 1000 }]) {
      const t = vt.createTerminal(10, 3, config) as OfficialTerminal;
      expect(defaults(t)).toEqual({
        cellFg: 0xcccccc,
        cellBg: 0,
        osc10: '\x1b]10;rgb:cccc/cccc/cccc\x07',
        osc11: '\x1b]11;rgb:0000/0000/0000\x07',
      });
      t.write('\x1b]11;rgb:20/40/60\x1b\\');
      t.update();
      expect(bgRgb((t.getLine(0) ?? [])[0])).toBe(0x204060);
      t.write('\x1b]111\x1b\\\x1b[?5h');
      t.update();
      expect(bgRgb((t.getLine(0) ?? [])[0])).toBe(0xcccccc);
      expect(rgb((t.getLine(0) ?? [])[0])).toBe(0);
      t.free();
    }
  });
});

describe('official engine: scrollback in lines (ADR 046)', () => {
  /** Writes `n` numbered lines and returns how many scrollback rows the terminal kept. */
  function keep(config: object | undefined, n: number, cols = 80): number {
    const t = vt.createTerminal(cols, 24, config) as OfficialTerminal;
    let chunk = '';
    for (let i = 0; i < n; i++) {
      chunk += `line ${i}\r\n`;
      if (chunk.length > 1 << 20) {
        t.write(chunk);
        chunk = '';
      }
    }
    t.write(chunk);
    t.update();
    const kept = t.getScrollbackLength();
    t.free();
    return kept;
  }

  test('keeps about scrollbackLines lines, a page at most under', () => {
    const kept = keep({ scrollbackLines: 10000 }, 15000);
    expect(kept).toBeGreaterThan(9000);
    expect(kept).toBeLessThanOrEqual(10000 + 200);
  });

  test('scrollbackLines 0 removes the line limit', () => {
    expect(keep({ scrollbackLines: 0 }, 20000)).toBe(20000 - 24 + 1);
  });

  test('without scrollbackLines keeps the default 10,000 lines', () => {
    for (const config of [undefined, THEME]) {
      const kept = keep(config, 15000);
      expect(kept).toBeGreaterThan(9000);
      expect(kept).toBeLessThanOrEqual(10000 + 200);
    }
  });
});

describe('EngineConfig', () => {
  test('the limits and fallbacks are the documented values', () => {
    expect(SCROLLBACK_CEILING_BYTES).toBe(32 * 1024 * 1024);
    expect(DEFAULT_SCROLLBACK_LINES).toBe(10000);
    expect([FALLBACK_FOREGROUND, FALLBACK_BACKGROUND]).toEqual([0xcccccc, 0]);
  });

  test.each([
    [0x000000, [0, 0, 0]],
    [0xffffff, [255, 255, 255]],
    [0x123456, [0x12, 0x34, 0x56]],
  ])('writeRgb(%i) writes r, g and b at their offsets', (value, bytes) => {
    const ctx = bindingContext(vt, 4, 2, configSlots(vt.L));
    const C = ctx.L.colors;
    writeRgb(ctx, ctx.at.palette, value);
    const u8 = ctx.u8();
    const at = ctx.at.palette;
    expect([u8[at + C.r], u8[at + C.g], u8[at + C.b]]).toEqual(bytes);
    freeContext(ctx);
  });

  test('mode 12 follows the default cursor and DECSCUSR, never mode 12 itself', () => {
    const ctx = bindingContext(vt, 10, 3, configSlots(vt.L));
    const config = new EngineConfig(ctx);
    config.apply({ cursorBlink: true });
    expect(ctx.getMode(12)).toBe(true);
    // Grapheme clustering is on by default
    expect(ctx.getMode(2027)).toBe(true);
    const write = (text: string) => {
      const bytes = new TextEncoder().encode(text);
      const ptr = ctx.ex.ghostty_wasm_alloc(bytes.length);
      ctx.u8().set(bytes, ptr);
      ctx.ex.ghostty_terminal_vt_write(ctx.term, ptr, bytes.length);
      ctx.ex.ghostty_wasm_free(ptr, bytes.length);
      config.afterWrite(text);
    };
    write('\x1b[?12l');
    expect(ctx.getMode(12)).toBe(true);
    write('\x1b[2 q');
    expect(ctx.getMode(12)).toBe(false);
    // A sequence split across writes is still seen
    write('\x1b[1');
    write(' q');
    expect(ctx.getMode(12)).toBe(true);
    write('\x1b[2 q\x1b[0 q');
    expect(ctx.getMode(12)).toBe(true);
    const gen = ctx.generation;
    config.setDefaultCursor('bar', false);
    expect(ctx.getMode(12)).toBe(false);
    expect(ctx.generation).toBe(gen + 1);
    freeContext(ctx);
  });
});
