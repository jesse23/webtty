// The canvas renderer's test harness (test support, ADR 064): renderers on raster
// canvases with an injected document, a terminal with overflowing glyphs, colours and
// links, and the independent "previous renderer" every partial frame is compared with.

import type { IntervalTimers, IScrollbackProvider } from '../../ghostty-web/render/renderable';
import { CanvasRenderer, type RendererOptions } from '../../ghostty-web/renderer';
import { type DrawLog, type RasterCanvas, rasterCanvas } from './raster-canvas';
import { loadGhostty } from './wasm';

/** The test terminal's width and height. */
export const COLS = 30;
export const ROWS = 8;

/** A renderer on its own raster canvases, with what it painted and copied. */
export interface RasterRenderer {
  r: CanvasRenderer;
  /** The device pixels the element shows. */
  shown(): string[];
  /** The device pixels of the line the bottom edge strip stretches. */
  lastLine(): string[];
  /** Blanks the drawing canvas and resets its context, as a lost and restored context does. */
  lose(): void;
  /** The canvas rows painted with a line, in order. */
  drawn: number[];
  /** The copied scrolls so far. */
  copies(): number;
  /** The scratch canvas partial repaints draw on. */
  scratch: HTMLCanvasElement;
}

/**
 * A fresh renderer at ratio `dpr`, sized COLS × `rows`, on raster canvases its injected
 * document creates: the drawing canvas first, then the scratch and the font measure. The
 * cursor blinks on `timers` when given.
 */
export function rasterRenderer(
  dpr: number,
  options: RendererOptions = {},
  rows: number = ROWS,
  timers?: IntervalTimers,
): RasterRenderer {
  const element = rasterCanvas();
  const log: DrawLog = { rows: [], copies: 0 };
  const created: RasterCanvas[] = [];
  const document = {
    createElement: () => {
      const canvas = rasterCanvas(log);
      created.push(canvas);
      return canvas.canvas;
    },
  } as unknown as Document;
  const deps = { document, timers };
  const r = new CanvasRenderer(element.canvas, { ...options, devicePixelRatio: dpr }, deps);
  const [raster, scratch] = created;
  r.resize(COLS, rows);
  return {
    r,
    shown: () => {
      const { y, height } = r.visibleArea;
      const width = raster.canvas.width;
      return raster.pixels().slice(y * width, (y + height) * width);
    },
    lastLine: () => {
      const width = raster.canvas.width;
      const y = r.visibleArea.lastLine;
      return raster.pixels().slice(y * width, (y + 1) * width);
    },
    lose: raster.lose,
    drawn: log.rows,
    copies: () => log.copies,
    scratch: scratch.canvas,
  };
}

/** Splits a fractional position into viewportY and an offset snapped to device pixels. */
export function splitPosition(position: number, cellHeight: number, dpr: number) {
  const line = Math.floor(position);
  const offset = Math.round((position - line) * cellHeight * dpr) / dpr;
  return offset >= cellHeight ? { line: line + 1, offset: 0 } : { line, offset };
}

/** A scrollback provider over `term`'s scrollback, read live. */
export function scrollbackOf(term: TestTerminal): Required<IScrollbackProvider> {
  return {
    getScrollbackLine: (o: number) => term.getScrollbackLine(o),
    getScrollbackLength: () => term.getScrollbackLength(),
    getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
  };
}

/** A terminal of the official engine. */
export type TestTerminal = ReturnType<Awaited<ReturnType<typeof loadGhostty>>['createTerminal']>;

/** The test terminal and a provider over the scrollback length it had when written. */
export interface Written {
  term: TestTerminal;
  provider: Required<IScrollbackProvider>;
}

/**
 * A COLS × ROWS terminal with 40 lines of colours, backgrounds, a wide character,
 * combining marks and descenders that overflow into the rows above and below, OSC 8 links,
 * and the cursor mid-screen, so a scroll moves it onto another row in view.
 */
export async function writtenTerminal(): Promise<Written> {
  const ghostty = await loadGhostty();
  const term = ghostty.createTerminal(COLS, ROWS, { scrollbackLines: 10000 });
  for (let i = 0; i < 40; i++) {
    term.write(
      i % 3 === 0
        ? `\x1b[3${i % 8}mline ${i} é g\x1b[0m\r\n`
        : i % 3 === 1
          ? `\x1b[4${i % 8}m bg ${i} \x1b[0m 中 g\r\n`
          : `plain ${i} á\r\n`,
    );
    // OSC 8 links, two lines each
    if (i % 7 === 0)
      term.write(`\x1b]8;;https://x/${i % 2}\x1b\\link ${i}\r\nmore g\x1b]8;;\x1b\\\r\n`);
  }
  term.write('$ prompt\x1b[5;3H');
  const sb = term.getScrollbackLength();
  const provider = { ...scrollbackOf(term), getScrollbackLength: () => sb };
  return { term, provider };
}

/**
 * What the previous renderer showed at a position, drawn independently: the viewport
 * as a screen of its own lines, nothing below it, and at a fraction of a line the
 * bottom of the line above drawn on its own (ADR 040's strip). No scrollbar.
 */
export function previousFrame(
  { term, provider }: Written,
  view: number,
  offset: number,
  dpr: number,
): string[] {
  const sb = provider.getScrollbackLength();
  const source = (r: number) =>
    r < view
      ? {
          line: provider.getScrollbackLine(sb - view + r),
          grapheme: (c: number) => provider.getScrollbackGraphemeString(sb - view + r, c),
        }
      : {
          line: term.getLine(r - view),
          grapheme: (c: number) => term.getGraphemeString(r - view, c),
        };
  const screen = (from: number, count: number, cursor: boolean) => {
    const lines = Array.from({ length: count }, (_, i) => source(from + i));
    const t = rasterRenderer(dpr, {}, count);
    t.r.render(
      {
        getLine: (y) => lines[y]?.line ?? null,
        getGraphemeString: (y, c) => lines[y].grapheme(c),
        getCursor: () => (cursor ? term.getCursor() : { x: 0, y: 0, visible: false }),
        getDimensions: () => ({ cols: COLS, rows: count }),
        isRowDirty: () => false,
        clearDirty: () => {},
      },
      true,
      0,
    );
    return t.shown();
  };
  const width = COLS * 8 * dpr;
  const cut = offset * dpr * width;
  const viewport = screen(0, ROWS, view === 0);
  if (!offset) return viewport;
  const above = screen(-1, 1, false);
  return [...above.slice(above.length - cut), ...viewport.slice(0, viewport.length - cut)];
}

/** A selection source over lines of the buffer, as SelectionManager keeps it. */
export interface LineSelection {
  startCol: number;
  startLine: number;
  endCol: number;
  endLine: number;
}

/**
 * A selection source reading `selection()` and mapping its buffer lines to viewport rows
 * at `view()` over `term`'s scrollback.
 */
export function selectionOf(
  term: TestTerminal,
  selection: () => LineSelection | null,
  view: () => number,
) {
  return {
    hasSelection: () => selection() !== null,
    getSelectionRange: () => {
      const s = selection();
      if (!s) return null;
      const sb = term.getScrollbackLength();
      return {
        startCol: s.startCol,
        startRow: s.startLine - sb + view(),
        endCol: s.endCol,
        endRow: s.endLine - sb + view(),
      };
    },
  };
}
