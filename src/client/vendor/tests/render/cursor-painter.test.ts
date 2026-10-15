import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import type { GhosttyCell } from '../../ghostty-web/engine/cell-types';
import {
  CURSOR_BLINK_INTERVAL_MS,
  CursorBlink,
  CursorPainter,
} from '../../ghostty-web/render/cursor-painter';
import { DEFAULT_THEME } from '../../ghostty-web/render/default-theme';
import type { RowSource } from '../../ghostty-web/render/frame-lines';
import type { CellTextPainter, PaintSettings } from '../../ghostty-web/render/renderable';
import { ROW_INVALID, ROW_JOINED } from '../../ghostty-web/render/row-band';
import { recordingContext } from '../support/recording-context';
import { COLS, ROWS, rasterRenderer, writtenTerminal } from '../support/renderer-harness';
import { loadGhostty } from '../support/wasm';

describe('CursorBlink', () => {
  test('toggles every 530 ms while enabled and shows the cursor when stopped', () => {
    const clock = new ManualClock();
    const blink = new CursorBlink(clock);
    expect(CURSOR_BLINK_INTERVAL_MS).toBe(530);
    expect([blink.enabled, blink.visible]).toEqual([false, true]);
    blink.setEnabled(true);
    expect(blink.enabled).toBe(true);
    clock.advance(529);
    expect(blink.visible).toBe(true);
    clock.advance(1);
    expect(blink.visible).toBe(false);
    clock.advance(530);
    expect(blink.visible).toBe(true);
    clock.advance(530);
    blink.setEnabled(false);
    expect([blink.enabled, blink.visible]).toEqual([false, true]);
    expect(clock.pending.timers).toBe(0);
  });

  test('enabling twice starts one timer', () => {
    const clock = new ManualClock();
    const blink = new CursorBlink(clock);
    blink.setEnabled(true);
    blink.setEnabled(true);
    expect(clock.pending.timers).toBe(1);
    blink.setEnabled(false);
    blink.setEnabled(false);
    expect(clock.pending.timers).toBe(0);
  });

  test('dispose stops the timer, shows the cursor, and a second dispose does nothing', () => {
    const clock = new ManualClock();
    const blink = new CursorBlink(clock);
    blink.setEnabled(true);
    clock.advance(530);
    blink.dispose();
    expect(clock.pending.timers).toBe(0);
    expect(blink.visible).toBe(true);
    blink.dispose();
    expect(clock.pending.timers).toBe(0);
  });
});

describe('CursorPainter', () => {
  const settings: PaintSettings = {
    fontSize: 15,
    fontFamily: 'mono',
    metrics: { width: 8, height: 20, baseline: 14 },
    theme: { ...DEFAULT_THEME, cursor: '#c0ffee', cursorAccent: '#000001' },
    devicePixelRatio: 1,
  };
  const cell = { codepoint: 0x61, width: 1 } as GhosttyCell;

  function painter(style: 'block' | 'underline' | 'bar' = 'block') {
    const texts: string[] = [];
    const cells: CellTextPainter = {
      paintCellText: (_ctx, c, x, y, color, grapheme) =>
        texts.push(`${c.codepoint} ${x},${y} ${color} ${grapheme(x)}`),
    };
    const counter = { draws: 0 };
    return { p: new CursorPainter(style, cells, settings, counter), texts, counter };
  }

  const source = (line: GhosttyCell[] | null): RowSource => ({
    buffer: {
      getGraphemeString: (row: number, col: number) => `g${row}:${col}`,
    } as unknown as RowSource['buffer'],
    getLine: () => line,
    rows: 4,
    scrollback: undefined,
    scrollbackLength: 0,
  });

  test.each([
    ['underline', ['fillStyle=#c0ffee', 'fillRect(16,57,8,3)']],
    ['bar', ['fillStyle=#c0ffee', 'fillRect(16,40,2,20)']],
  ] as const)('the %s cursor fills its shape', (style, calls) => {
    const t = painter(style);
    const { ctx, calls: drawn } = recordingContext();
    t.p.paint(ctx, 2, 2, 0, source([cell, cell, cell]));
    expect(drawn).toEqual([...calls]);
    expect(t.texts).toEqual([]);
    expect(t.counter.draws).toBe(1);
  });

  test('the block cursor draws its cell again in the accent colour, with the screen row grapheme', () => {
    const t = painter('block');
    const { ctx, calls } = recordingContext();
    t.p.paint(ctx, 1, 5, 2, source([cell, cell]));
    expect(calls).toEqual([
      'fillStyle=#c0ffee',
      'fillRect(8,100,8,20)',
      'save()',
      'beginPath()',
      'rect(8,100,8,20)',
      'clip()',
      'restore()',
    ]);
    // Canvas row 5, grapheme of screen row 2
    expect(t.texts).toEqual(['97 1,5 #000001 g2:1']);
    // No cell under it: only the block
    t.texts.length = 0;
    t.p.paint(recordingContext().ctx, 1, 5, 2, source(null));
    expect(t.texts).toEqual([]);
  });

  test('invalidateDrawn keeps the same cursor and invalidates a moved, hidden or reshaped one', () => {
    const t = painter();
    const state = () => new Uint8Array(6).fill(ROW_JOINED);
    // Nothing drawn yet: nothing to invalidate
    let s = state();
    expect(t.p.invalidateDrawn(s, true, 2, 3)).toBe(false);
    expect([...s]).toEqual([...state()]);
    t.p.drawnAt(2, 3);
    // The same cursor
    s = state();
    expect(t.p.invalidateDrawn(s, true, 2, 3)).toBe(true);
    expect(s[2]).toBe(ROW_JOINED);
    // Moved a column, hidden, moved a row
    for (const [draws, row, col] of [
      [true, 2, 4],
      [false, 2, 3],
      [true, 3, 3],
    ] as const) {
      s = state();
      expect(t.p.invalidateDrawn(s, draws, row, col)).toBe(false);
      expect(s[2]).toBe(ROW_INVALID);
    }
    // A shape change once, then the same again
    t.p.setStyle('bar');
    s = state();
    expect(t.p.invalidateDrawn(s, true, 2, 3)).toBe(false);
    expect(t.p.invalidateDrawn(state(), true, 2, 3)).toBe(true);
    t.p.setStyle('bar');
    expect(t.p.invalidateDrawn(state(), true, 2, 3)).toBe(true);
    t.p.markShapeChanged();
    expect(t.p.invalidateDrawn(state(), true, 2, 3)).toBe(false);
    // A copied scroll moves the drawn row
    t.p.shift(2);
    s = state();
    expect(t.p.invalidateDrawn(s, true, 4, 3)).toBe(true);
    t.p.drawnAt(null, 0);
    t.p.shift(1);
    expect(t.p.invalidateDrawn(state(), true, 4, 3)).toBe(false);
  });
});

describe('the cursor through the renderer', () => {
  test(`a translucent cursor drawn again is not blended over itself`, async () => {
    const { term, provider } = await writtenTerminal();
    const theme = { cursor: 'rgba(255, 0, 0, 0.3)' };
    // The shape is the engine's (ADR 049)
    for (const [cursorStyle, ps] of [
      ['block', 2],
      ['bar', 6],
      ['underline', 4],
    ] as const) {
      term.write(`\x1b[${ps} q`);
      const live = rasterRenderer(2, { theme, cursorStyle });
      live.r.render(term, true, 0, provider, 1);
      // Idle frames, a scroll away and back, and a frame that repaints the cursor row
      for (const [y, force] of [
        [0, false],
        [0, false],
        [2, false],
        [0, false],
        [0, false],
        [0, true],
        [0, false],
      ] as const) {
        live.r.render(term, force, y, provider, 1);
        const full = rasterRenderer(2, { theme, cursorStyle });
        full.r.render(term, true, y, provider, 1);
        expect(live.shown()).toEqual(full.shown());
      }
      live.r.dispose();
    }
    term.free();
  });

  test(`draws the cursor shape the engine reports, not the configured one (ADR 049)`, async () => {
    const { term, provider } = await writtenTerminal();
    // The same terminal with the shape left to the renderer's option
    const optionShape = new Proxy(term, {
      get: (t, k) => {
        if (k === 'getCursor') {
          return () => {
            const { style: _s, blinking: _b, ...cursor } = t.getCursor();
            return cursor;
          };
        }
        const v = t[k as keyof typeof t];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    term.write('\x1b[4 q');
    const live = rasterRenderer(2, { cursorStyle: 'block' });
    live.r.render(term, true, 0, provider, 1);
    const underline = rasterRenderer(2, { cursorStyle: 'underline' });
    underline.r.render(optionShape, true, 0, provider, 1);
    expect(live.shown()).toEqual(underline.shown());
    // A later DECSCUSR repaints the cursor cell on the next frame
    term.write('\x1b[6 q');
    live.r.render(term, false, 0, provider, 1);
    const bar = rasterRenderer(2, { cursorStyle: 'bar' });
    bar.r.render(optionShape, true, 0, provider, 1);
    expect(live.shown()).toEqual(bar.shown());
    expect(live.shown()).not.toEqual(underline.shown());
    term.free();
  });

  test(`the block cursor redraws the grapheme of its own screen row`, async () => {
    const ghostty = await loadGhostty();
    const term = ghostty.createTerminal(COLS, ROWS, { scrollbackLines: 10000 });
    // Every row starts with a cluster of its own, the cursor on a combining one
    term.write(Array.from({ length: ROWS }, (_, i) => `${'abcdefgh'[i]}́̂ ${i}`).join('\r\n'));
    term.write('\x1b[3;1H');
    const accent = '#00ff01';
    const live = rasterRenderer(2, { cursorStyle: 'block', theme: { cursorAccent: accent } });
    live.r.render(term, true, 0, undefined, 1);
    // The cursor draws its character in the accent colour
    const accented = new Set(
      live
        .shown()
        .filter((p) => p.startsWith(`${accent} `))
        .map((p) => p.slice(p.lastIndexOf(' ') + 1)),
    );
    expect([...accented]).toEqual([term.getGraphemeString(2, 0)]);
    expect([...accented][0]).toBe('ć̂');
    live.r.dispose();
    term.free();
  });

  test('the blink hides and shows the cursor on the frames after each 530 ms tick', async () => {
    const { term, provider } = await writtenTerminal();
    const clock = new ManualClock();
    const live = rasterRenderer(2, {}, ROWS, clock);
    // The engine reports a blinking cursor (DECSCUSR 1)
    term.write('\x1b[1 q');
    live.r.render(term, true, 0, provider, 1);
    const shown = live.shown();
    const version = live.r.visibleArea.version;
    clock.advance(CURSOR_BLINK_INTERVAL_MS);
    live.r.render(term, false, 0, provider, 1);
    expect(live.r.visibleArea.version).toBeGreaterThan(version);
    expect(live.shown()).not.toEqual(shown);
    clock.advance(CURSOR_BLINK_INTERVAL_MS);
    live.r.render(term, false, 0, provider, 1);
    expect(live.shown()).toEqual(shown);
    // A steady cursor stops the timer
    term.write('\x1b[2 q');
    live.r.render(term, false, 0, provider, 1);
    expect(clock.pending.timers).toBe(0);
    live.r.dispose();
    term.free();
  });
});
