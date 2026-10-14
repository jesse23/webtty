import { describe, expect, test } from 'bun:test';
import { DEFAULT_THEME } from '../../ghostty-web/render/default-theme';
import type { PaintSettings, RowContent, RowPainter } from '../../ghostty-web/render/renderable';
import { ROW_CUT, ROW_INVALID, ROW_JOINED } from '../../ghostty-web/render/row-band';
import { REPAINT_CHUNK_ROWS, RowRepainter } from '../../ghostty-web/render/row-repainter';
import {
  COLS,
  type LineSelection,
  previousFrame,
  ROWS,
  rasterRenderer,
  scrollbackOf,
  selectionOf,
  splitPosition,
  writtenTerminal,
} from '../support/renderer-harness';
import { loadGhostty } from '../support/wasm';

/** A context that records every call and property write, in order. */
function recordingContext() {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_t, key) =>
        (...args: unknown[]) =>
          calls.push(`${String(key)}(${args.join(',')})`),
      set: (_t, key, value) => {
        calls.push(`${String(key)}=${value}`);
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** Paint settings for 8 × 15 px cells at `dpr`. */
function settingsAt(dpr: number): PaintSettings {
  return {
    fontSize: 15,
    fontFamily: 'monospace',
    metrics: { width: 8, height: 15, baseline: 11 },
    theme: DEFAULT_THEME,
    devicePixelRatio: dpr,
  };
}

/** A RowRepainter on recording contexts, with a painter that logs which rows it drew where. */
function repainter(dpr = 2) {
  const own = recordingContext();
  const scratchContext = recordingContext();
  const canvas = { width: 240 * dpr, height: 0 } as HTMLCanvasElement;
  const scratch = {
    width: 99,
    height: 99,
    getContext: () => scratchContext.ctx,
  } as unknown as HTMLCanvasElement;
  const painted: string[] = [];
  const rows: RowPainter = {
    paintRow: (ctx, k) => painted.push(`${ctx === own.ctx ? 'canvas' : 'scratch'} ${k}`),
  };
  const counter = { draws: 0 };
  const r = new RowRepainter(canvas, own.ctx, scratch, rows, settingsAt(dpr), counter);
  const rowAt = (): RowContent => ({ line: null });
  return { r, own, scratchContext, scratch, painted, counter, rowAt };
}

describe('RowRepainter', () => {
  test('frees the scratch canvas when created and on freeScratch', () => {
    const t = repainter();
    expect([t.scratch.width, t.scratch.height]).toEqual([0, 0]);
    t.scratch.height = 40;
    t.r.freeScratch();
    expect(t.scratch.height).toBe(0);
  });

  test('a cut run between invalid rows is drawn on the canvas itself', () => {
    const t = repainter();
    const state = new Uint8Array(6).fill(ROW_INVALID);
    t.r.repaint(state, 2, 3, true, COLS, t.rowAt);
    expect(t.painted).toEqual(['canvas 2', 'canvas 3']);
    expect([...state]).toEqual([0, 0, ROW_JOINED, ROW_CUT, 0, 0]);
    expect(t.counter.draws).toBe(1);
  });

  test('a run next to kept rows is drawn on the scratch canvas with the next line, then copied', () => {
    const t = repainter();
    const state = new Uint8Array(6).fill(ROW_JOINED);
    t.r.repaint(state, 1, 2, false, COLS, t.rowAt);
    expect(t.painted).toEqual(['scratch 1', 'scratch 2', 'scratch 3']);
    expect([...state]).toEqual(Array(6).fill(ROW_JOINED));
    // The scratch is moved up so canvas row 1 is at its top, and three rows high
    expect(t.scratchContext.calls[0]).toBe(`setTransform(2,0,0,2,0,${-30})`);
    expect(t.scratch.height).toBe(3 * 30);
    // The rows are replaced, not blended, in device pixels
    expect(t.own.calls).toEqual([
      'save()',
      'setTransform(1,0,0,1,0,0)',
      'globalAlpha=1',
      'globalCompositeOperation=source-over',
      'imageSmoothingEnabled=false',
      `clearRect(0,30,480,60)`,
      `drawImage([object Object],0,0,480,60,0,30,480,60)`,
      'restore()',
    ]);
  });

  test('a long run is drawn in chunks, each with its next line, and the last cut', () => {
    const t = repainter(1);
    const total = 2 * REPAINT_CHUNK_ROWS + 4;
    const state = new Uint8Array(total + 1).fill(ROW_JOINED);
    t.r.repaint(state, 0, total - 1, true, COLS, t.rowAt);
    // Chunk ends: the next line is drawn for the first two, not for the cut last one
    const drawn = t.painted.map((p) => Number(p.split(' ')[1]));
    expect(drawn).toEqual([
      ...Array.from({ length: REPAINT_CHUNK_ROWS + 1 }, (_, i) => i),
      ...Array.from({ length: REPAINT_CHUNK_ROWS + 1 }, (_, i) => i + REPAINT_CHUNK_ROWS),
      ...Array.from({ length: 4 }, (_, i) => i + 2 * REPAINT_CHUNK_ROWS),
    ]);
    expect(t.scratch.height).toBe((REPAINT_CHUNK_ROWS + 1) * 15);
    expect(state[total - 1]).toBe(ROW_CUT);
  });

  test('repaintView repaints only the rows not as a full redraw leaves them', () => {
    const t = repainter();
    // Rows 2-5 in view, the last cut; row 3 changed
    const state = Uint8Array.from([0, 0, ROW_JOINED, ROW_INVALID, ROW_JOINED, ROW_CUT, 0]);
    const repainted = t.r.repaintView(state, 2, 2, 5, COLS, t.rowAt);
    expect([...repainted]).toEqual([0, 0, 0, 1, 0, 0, 0]);
    expect(t.painted).toEqual(['scratch 3', 'scratch 4']);
    // Nothing to do: nothing drawn
    t.painted.length = 0;
    expect([...t.r.repaintView(state, 2, 2, 5, COLS, t.rowAt)]).toEqual(Array(7).fill(0));
    expect(t.painted).toEqual([]);
  });

  test('shiftRows copies the canvas onto itself with the copy operator', () => {
    const t = repainter(2);
    const canvas = { width: 480, height: 300 } as HTMLCanvasElement;
    const counter = { draws: 0 };
    const noRows = { paintRow: () => {} };
    const r = new RowRepainter(canvas, t.own.ctx, t.scratch, noRows, settingsAt(2), counter);
    r.shiftRows(2);
    r.shiftRows(-1);
    expect(t.own.calls.filter((c) => c.startsWith('drawImage'))).toEqual([
      'drawImage([object Object],0,0,480,240,0,60,480,240)',
      'drawImage([object Object],0,30,480,270,0,0,480,270)',
    ]);
    expect(t.own.calls).toContain('globalCompositeOperation=copy');
    expect(counter.draws).toBe(2);
  });

  test('a scratch canvas without a 2D context throws', () => {
    const t = repainter();
    const broken = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    const canvas = { width: 480 } as HTMLCanvasElement;
    const noRows = { paintRow: () => {} };
    const r = new RowRepainter(canvas, t.own.ctx, broken, noRows, settingsAt(1), { draws: 0 });
    const state = new Uint8Array(4).fill(ROW_JOINED);
    expect(() => r.repaint(state, 1, 1, false, COLS, t.rowAt)).toThrow('2D rendering context');
  });
});

describe('partial repaints equal a full redraw (ADR 043)', () => {
  test(`the rows in view equal the previous renderer at every position`, async () => {
    const t = await writtenTerminal();
    const sb = t.provider.getScrollbackLength();
    for (const [dpr, overscan] of [
      [1, 3],
      [2, 1],
      [2, 2],
      [2, undefined],
    ] as const) {
      const live = rasterRenderer(dpr, { overscan });
      const h = live.r.getMetrics().height;
      live.r.render(t.term, true, 0, t.provider, 0);
      // Trackpad steps up and down, a jump past the overscan, line steps, the top
      const positions = [
        ...Array.from({ length: 24 }, (_, i) => i * 0.35),
        18.6,
        15.4,
        ...Array.from({ length: 12 }, (_, i) => 15.4 - i * 0.45),
        ...[1, 2, 5, 4, 0, 3, 10, 9, 17, 16, 0.5, 0],
        ...[sb, sb - 0.25, sb - 7.75, 0],
      ];
      for (const p of positions) {
        const { line, offset } = splitPosition(p, h, dpr);
        live.r.setScrollOffset(offset);
        live.r.render(t.term, false, line, t.provider, 0);
        expect(live.r.scrollOffset).toBe(offset);
        expect(live.shown()).toEqual(previousFrame(t, line, offset, dpr));
        // The bottom strip's line is the last row's own, at any fraction: not the
        // glyphs the part in view ends on, offset above it.
        const area = live.r.visibleArea;
        expect(area.lastLine).toBe(area.y + area.height - 1 + offset * dpr);
        const whole = previousFrame(t, line, 0, dpr);
        expect(live.lastLine()).toEqual(whole.slice(whole.length - COLS * 8 * dpr));
      }
    }
    t.term.free();
  });

  test(`random scrolls, output, selection, hover and scrollbar equal a full redraw`, async () => {
    const { term } = await writtenTerminal();
    const provider = scrollbackOf(term);
    // A fixed pseudo-random sequence
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let view = 0;
    let selection: LineSelection | null = null;
    const manager = selectionOf(
      term,
      () => selection,
      () => view,
    );
    let range: { startX: number; startY: number; endX: number; endY: number } | null = null;
    for (const overscan of [1, 3]) {
      const options = { overscan };
      const live = rasterRenderer(2, options);
      live.r.setSelectionManager(manager);
      const h = live.r.getMetrics().height;
      let position = 0;
      let opacity = 1;
      for (let step = 0; step < 500; step++) {
        const sb = term.getScrollbackLength();
        // Some steps also move, so a change can land on the frame that copies rows
        const op = random();
        if (op >= 0.45 && random() < 0.4) position += (random() - 0.5) * 10;
        if (op < 0.45) position += (random() - 0.5) * (random() < 0.3 ? 14 : 4);
        else if (op < 0.5) position = 0;
        else if (op < 0.6) {
          const i = Math.floor(random() * 30);
          term.write(i % 2 ? `out ${i} é g\r\n` : `\x1b[4${i % 8}m${i}\x1b[0m 中 g`);
        } else if (op < 0.7) opacity = opacity ? 0 : 1;
        else if (op < 0.8) {
          const line = Math.floor(random() * (sb + ROWS));
          selection =
            random() < 0.3
              ? null
              : {
                  startCol: Math.floor(random() * COLS),
                  startLine: line,
                  endCol: Math.floor(random() * COLS),
                  endLine: line + Math.floor(random() * 6),
                };
        } else {
          const y = Math.floor(random() * ROWS);
          range = random() < 0.3 ? null : { startX: 2, startY: y, endX: 6, endY: y };
        }
        position = Math.max(0, Math.min(term.getScrollbackLength(), position));
        const { line, offset } = splitPosition(position, h, 2);
        view = line;
        live.r.setHoveredLinkRange(range);
        live.r.setScrollOffset(offset);
        live.r.render(term, false, view, provider, opacity);
        const full = rasterRenderer(2, options);
        full.r.setSelectionManager(manager);
        full.r.setHoveredLinkRange(range);
        full.r.setScrollOffset(offset);
        full.r.render(term, true, view, provider, opacity);
        expect(live.shown()).toEqual(full.shown());
      }
    }
    term.free();
  });

  test(`long runs are repainted in chunks on a small scratch canvas, as a full redraw`, async () => {
    const tall = 3 * REPAINT_CHUNK_ROWS + 5;
    const ghostty = await loadGhostty();
    const term = ghostty.createTerminal(COLS, tall, { scrollbackLines: 10000 });
    const provider = scrollbackOf(term);
    // Every line overflows into the rows above and below, so each chunk's edges matter
    const lines = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => `\x1b[4${(from + i) % 8}m${from + i} é g\x1b[0m`);
    term.write(lines(0, tall * 2).join('\r\n'));
    for (const overscan of [1, 4]) {
      const live = rasterRenderer(2, { overscan }, tall);
      const rowHeight = live.r.getMetrics().height * 2;
      live.r.render(term, true, 0, provider, 1);
      // New output moves every row, a clear blanks them, and scrolls copy and draw rows
      for (const [output, y] of [
        [`\r\n${lines(100, 3).join('\r\n')}`, 0],
        ['', 2 * REPAINT_CHUNK_ROWS + 1],
        ['', 4],
        ['', 0],
        ['\x1b[2J\x1b[H', 0],
        [lines(200, tall - 1).join('\r\n'), 0],
      ] as const) {
        term.write(output);
        live.r.render(term, false, y, provider, 1);
        const full = rasterRenderer(2, { overscan }, tall);
        full.r.render(term, true, y, provider, 1);
        expect(live.shown()).toEqual(full.shown());
        expect(live.scratch.height).toBeLessThanOrEqual((REPAINT_CHUNK_ROWS + 1) * rowHeight);
      }
    }
    term.free();
  });

  test(`rows out of view follow output at the bottom`, async () => {
    const { term } = await writtenTerminal();
    const provider = scrollbackOf(term);
    const live = rasterRenderer(2, { overscan: 4 });
    live.r.render(term, true, 0, provider, 0);
    // Draw the rows above the viewport, return, and let output (a new line, then a line
    // changed in place) move the lines they show
    for (const output of [
      '\x1b[8;1H\r\nnew line é g',
      '\rsame line g\x1b[K',
      '\r\n\x1b[41m中中\x1b[0m',
    ]) {
      for (const y of [3, 2, 1, 0]) live.r.render(term, false, y, provider, 0);
      term.write(output);
      live.r.render(term, false, 0, provider, 0);
      for (const [y, offset] of [
        [0, 7.5],
        [2, 0],
        [3, 0.5],
      ]) {
        live.r.setScrollOffset(offset);
        live.r.render(term, false, y, provider, 0);
        expect(live.shown()).toEqual(previousFrame({ term, provider }, y, offset, 2));
      }
      live.r.setScrollOffset(0);
    }
    term.free();
  });

  test(`a scroll draws only the rows that came into view and the edges`, async () => {
    const t = await writtenTerminal();
    const live = rasterRenderer(2, { overscan: 6 });
    const h = live.r.getMetrics().height;
    live.r.render(t.term, true, 0, t.provider, 1);
    let view = 0;
    for (const y of [1, 2, 5, 4, 0, 3, 10, 9, 17, 16, 0, 1]) {
      const before = live.drawn.length;
      live.r.render(t.term, false, y, t.provider, 1);
      // The rows that came into view and the one their glyphs overflow into, the new
      // last row, and the row the old cursor moved to with the row below it.
      expect(live.drawn.length - before).toBeLessThanOrEqual(Math.abs(y - view) + 4);
      view = y;
    }
    // Up and down within the overscan once its rows are drawn: no copy, and per line
    // only the rows at the edges, which lose or gain what the line beyond draws into them
    for (let p = 1; p <= 4; p += 0.25) {
      const { line, offset } = splitPosition(p, h, 2);
      live.r.setScrollOffset(offset);
      live.r.render(t.term, false, line, t.provider, 1);
    }
    const copies = live.copies();
    const before = live.drawn.length;
    for (let p = 4; p >= 1; p -= 0.25) {
      const { line, offset } = splitPosition(p, h, 2);
      live.r.setScrollOffset(offset);
      live.r.render(t.term, false, line, t.provider, 1);
    }
    expect(live.copies()).toBe(copies);
    expect(live.drawn.length - before).toBeLessThanOrEqual(3 * 4 + 2);
    // Frames at a fraction of a line with nothing else changed draw nothing
    const still = live.drawn.length;
    for (const offset of [0.5, 3, 7.5, 3]) {
      live.r.setScrollOffset(offset);
      live.r.render(t.term, false, 1, t.provider, 1);
    }
    expect(live.drawn.length).toBe(still);
    t.term.free();
  });

  test(`a scroll past the overscan copies the rows still in view`, async () => {
    const t = await writtenTerminal();
    const live = rasterRenderer(2, { overscan: 2 });
    live.r.render(t.term, true, 0, t.provider, 0);
    live.r.render(t.term, false, 3, t.provider, 0);
    expect(live.copies()).toBe(1);
    expect(live.shown()).toEqual(previousFrame(t, 3, 0, 2));
    t.term.free();
  });

  test(`a scrolled frame with nothing changed draws no row`, async () => {
    const { term, provider } = await writtenTerminal();
    const live = rasterRenderer(2);
    live.r.render(term, true, 0, provider, 1);
    live.r.render(term, false, 6, provider, 1);
    const before = live.drawn.length;
    for (let i = 0; i < 3; i++) live.r.render(term, false, 6, provider, 1);
    expect(live.drawn.length).toBe(before);
    // Dropping the scrollbar repaints the rows in view, so none keeps the thumb.
    live.r.render(term, false, 6, provider, 0);
    expect(live.drawn.length - before).toBe(ROWS);
    const full = rasterRenderer(2);
    full.r.render(term, true, 6, provider, 0);
    expect(live.shown()).toEqual(full.shown());
    term.free();
  });
});
