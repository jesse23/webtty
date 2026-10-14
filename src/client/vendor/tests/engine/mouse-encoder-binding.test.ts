import { beforeAll, describe, expect, test } from 'bun:test';
import {
  MOUSE_REPORT_MAX,
  MouseEncoderBinding,
  mouseEncoderSlots,
} from '../../ghostty-web/engine/mouse-encoder-binding';
import type {
  Ghostty,
  GhosttyTerminal,
  MouseInput,
  OfficialTerminal,
} from '../../ghostty-web/ghostty';
import { Mods } from '../../ghostty-web/types';
import { bindingContext, freeContext, writeVt } from '../support/engine-harness';
import { THEME } from '../support/terminal-text';
import { countedGhostty, loadGhostty } from '../support/wasm';

// The wasm mouse encoder (ADR 049, ADR 061): every tracking mode and report format, the
// modifiers, the padding and the last-cell de-dup, through OfficialTerminal and directly.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('official engine: mouse encoder (ADR 049)', () => {
  // A 40x10 grid of 10 px cells with 5 px of padding on every side: the screen is
  // 410x110, and cell (col, row) 1-based spans x 5+10(col-1) .. 5+10col.
  const GEOMETRY = {
    screenWidth: 410,
    screenHeight: 110,
    cellWidth: 10,
    cellHeight: 10,
    paddingTop: 5,
    paddingRight: 5,
    paddingBottom: 5,
    paddingLeft: 5,
  };
  const at = (col: number, row: number) => ({ x: 5 + 10 * col - 5, y: 5 + 10 * row - 5 });
  const tracking = (modes: string, cols = 40) => {
    const t = term(cols, 10);
    t.write(modes);
    t.setMouseGeometry({ ...GEOMETRY, screenWidth: 10 + 10 * cols });
    return t;
  };
  const report = (
    t: GhosttyTerminal,
    action: MouseInput['action'],
    button: MouseInput['button'],
    pos: { x: number; y: number },
    mods = Mods.NONE,
    anyButtonPressed = action === 'press',
  ) =>
    new TextDecoder('latin1').decode(
      t.encodeMouse({ action, button, mods, ...pos, anyButtonPressed }),
    );

  test('SGR clicks carry Shift, Alt and Ctrl, not Super', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'left', at(3, 2))).toBe('\x1b[<0;3;2M');
    expect(report(t, 'release', 'left', at(3, 2))).toBe('\x1b[<0;3;2m');
    expect(report(t, 'press', 'left', at(3, 2), Mods.ALT)).toBe('\x1b[<8;3;2M');
    expect(report(t, 'press', 'left', at(3, 2), Mods.SUPER)).toBe('\x1b[<0;3;2M');
    expect(report(t, 'press', 'right', at(3, 2), Mods.SHIFT | Mods.CTRL)).toBe('\x1b[<22;3;2M');
    expect(report(t, 'press', 'middle', at(3, 2))).toBe('\x1b[<1;3;2M');
    t.free();
  });

  test('back and forward are buttons 8 and 9 (128, 129)', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'eight', at(1, 1))).toBe('\x1b[<128;1;1M');
    expect(report(t, 'release', 'nine', at(1, 1))).toBe('\x1b[<129;1;1m');
    t.free();
  });

  test('the wheel is buttons 4 and 5 in the format the app chose', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'four', at(7, 4), Mods.NONE, false)).toBe('\x1b[<64;7;4M');
    expect(report(t, 'press', 'five', at(7, 4), Mods.CTRL, false)).toBe('\x1b[<81;7;4M');
    t.write('\x1b[?1006l');
    expect(report(t, 'press', 'four', at(7, 4), Mods.NONE, false)).toBe("\x1b[M`'$");
    t.free();
  });

  test('any-event tracking reports hover as 35, once per cell', () => {
    const t = tracking('\x1b[?1003h\x1b[?1006h');
    const hover = (x: number, y: number) => report(t, 'motion', null, { x, y });
    expect(hover(26, 16)).toBe('\x1b[<35;3;2M');
    expect(hover(29, 19)).toBe('');
    expect(hover(36, 19)).toBe('\x1b[<35;4;2M');
    // A press sets the last cell too
    expect(report(t, 'press', 'left', at(5, 2))).toBe('\x1b[<0;5;2M');
    expect(report(t, 'motion', 'left', at(5, 2), Mods.NONE, true)).toBe('');
    expect(report(t, 'motion', 'left', at(6, 2), Mods.NONE, true)).toBe('\x1b[<32;6;2M');
    t.free();
  });

  test('a mode change resets the last cell', () => {
    const t = tracking('\x1b[?1003h\x1b[?1006h');
    expect(report(t, 'motion', null, at(2, 2))).toBe('\x1b[<35;2;2M');
    expect(report(t, 'motion', null, at(2, 2))).toBe('');
    // The format last set wins
    t.write('\x1b[?1015h');
    expect(report(t, 'motion', null, at(2, 2))).toBe('\x1b[67;2;2M');
    t.free();
  });

  test('normal tracking (1000) reports no motion, button tracking (1002) only drags', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'motion', 'left', at(2, 2), Mods.NONE, true)).toBe('');
    t.write('\x1b[?1002h');
    expect(report(t, 'motion', null, at(3, 2))).toBe('');
    expect(report(t, 'motion', 'left', at(3, 2), Mods.NONE, true)).toBe('\x1b[<32;3;2M');
    t.free();
  });

  test('X10 mode 9 reports presses of left, middle and right only, without modifiers', () => {
    const t = tracking('\x1b[?9h');
    expect(report(t, 'press', 'left', at(5, 3), Mods.SHIFT)).toBe('\x1b[M %#');
    expect(report(t, 'release', 'left', at(5, 3))).toBe('');
    expect(report(t, 'press', 'four', at(5, 3), Mods.NONE, false)).toBe('');
    expect(report(t, 'press', 'eight', at(5, 3))).toBe('');
    t.free();
  });

  test('X10 format: releases are button 3, and columns past 95 need bytes above 0x7f', () => {
    const t = tracking('\x1b[?1000h', 120);
    expect(report(t, 'press', 'left', at(5, 3), Mods.ALT)).toBe('\x1b[M(%#');
    expect(report(t, 'release', 'left', at(5, 3))).toBe('\x1b[M#%#');
    expect(report(t, 'press', 'left', at(95, 1))).toBe('\x1b[M \x7f!');
    expect([
      ...t.encodeMouse({
        action: 'press',
        button: 'left',
        mods: 0,
        ...at(96, 1),
        anyButtonPressed: true,
      }),
    ]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0x21]);
    t.free();
  });

  test('UTF-8 (1005), urxvt (1015) and SGR-pixels (1016) formats', () => {
    const t = tracking('\x1b[?1000h\x1b[?1005h', 300);
    const utf8 = new TextDecoder().decode(
      t.encodeMouse({
        action: 'press',
        button: 'left',
        mods: 0,
        ...at(200, 3),
        anyButtonPressed: true,
      }),
    );
    expect(utf8).toBe(`\x1b[M ${String.fromCodePoint(232)}#`);
    t.write('\x1b[?1005l\x1b[?1015h');
    expect(report(t, 'press', 'left', at(200, 3))).toBe('\x1b[32;200;3M');
    t.write('\x1b[?1015l\x1b[?1016h');
    // Pixels from the grid's origin, not the screen's
    expect(report(t, 'press', 'left', { x: 26, y: 17 })).toBe('\x1b[<0;21;12M');
    expect(report(t, 'release', 'left', { x: 2, y: 17 })).toBe('\x1b[<0;-3;12m');
    t.free();
  });

  test('the padding is the nearest edge cell; outside the screen only drags and releases', () => {
    const t = tracking('\x1b[?1002h\x1b[?1006h');
    expect(report(t, 'press', 'left', { x: 1, y: 1 })).toBe('\x1b[<0;1;1M');
    expect(report(t, 'press', 'left', { x: 408, y: 108 })).toBe('\x1b[<0;40;10M');
    // Dragged past the right edge: clamped to the edge cell
    expect(report(t, 'motion', 'left', { x: 600, y: 50 }, Mods.NONE, true)).toBe('\x1b[<32;40;5M');
    expect(report(t, 'motion', 'left', { x: -50, y: 50 }, Mods.NONE, true)).toBe('\x1b[<32;1;5M');
    expect(report(t, 'release', 'left', { x: -50, y: 50 }, Mods.NONE, false)).toBe('\x1b[<0;1;5m');
    // Outside with no button held: nothing
    expect(report(t, 'motion', null, { x: -50, y: 60 }, Mods.NONE, false)).toBe('');
    expect(report(t, 'press', 'left', { x: -50, y: 60 }, Mods.NONE, false)).toBe('');
    t.free();
  });

  test('no tracking reports nothing, and a reset terminal starts without tracking', () => {
    const t = tracking('');
    expect(report(t, 'press', 'left', at(1, 1))).toBe('');
    t.write('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'left', at(1, 1))).toBe('\x1b[<0;1;1M');
    t.write('\x1bc');
    expect(report(t, 'press', 'left', at(1, 1))).toBe('');
    t.free();
  });
});

describe('MouseEncoderBinding', () => {
  const press: MouseInput = {
    action: 'press',
    button: 'left',
    mods: 0,
    x: 15,
    y: 5,
    anyButtonPressed: false,
  };

  test('reports on a context of its own, within its report buffer', () => {
    const ctx = bindingContext(vt, 10, 3, mouseEncoderSlots(vt.L));
    const mouse = new MouseEncoderBinding(ctx);
    expect(ctx.at.mouseOut % 8).toBe(0);
    expect(MOUSE_REPORT_MAX).toBeGreaterThanOrEqual(32);
    mouse.setMouseGeometry({
      screenWidth: 100,
      screenHeight: 30,
      cellWidth: 10,
      cellHeight: 10,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
    });
    writeVt(ctx, '\x1b[?1000h\x1b[?1006h');
    expect(new TextDecoder().decode(mouse.encodeMouse(press))).toBe('\x1b[<0;2;1M');
    mouse.free();
    freeContext(ctx);
  });

  test('free() frees the encoder and event once, only if made; a second call is a no-op', async () => {
    const { ghostty, calls } = await countedGhostty([
      'ghostty_mouse_encoder_free',
      'ghostty_mouse_event_free',
    ]);
    const ctx = bindingContext(ghostty, 10, 3, mouseEncoderSlots(ghostty.L));
    const unused = new MouseEncoderBinding(ctx);
    unused.free();
    expect([calls.ghostty_mouse_encoder_free, calls.ghostty_mouse_event_free]).toEqual([0, 0]);
    const mouse = new MouseEncoderBinding(ctx);
    mouse.encodeMouse(press);
    mouse.free();
    mouse.free();
    expect([calls.ghostty_mouse_encoder_free, calls.ghostty_mouse_event_free]).toEqual([1, 1]);
    freeContext(ctx);
  });
});
