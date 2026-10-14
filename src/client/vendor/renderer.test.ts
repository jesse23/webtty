import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import {
  CanvasRenderer,
  frameLines,
  REPAINT_CHUNK_ROWS,
  watchDevicePixelRatio,
  wholeDevicePixelRatio,
} from './ghostty-web/renderer';
import type { GhosttyCell } from './ghostty-web/types';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

describe('wholeDevicePixelRatio', () => {
  test('keeps a whole ratio', () => {
    expect(wholeDevicePixelRatio(1)).toBe(1);
    expect(wholeDevicePixelRatio(2)).toBe(2);
  });

  test('rounds a fractional ratio up', () => {
    expect(wholeDevicePixelRatio(1.25)).toBe(2);
    expect(wholeDevicePixelRatio(1.36)).toBe(2);
    expect(wholeDevicePixelRatio(2.5)).toBe(3);
  });

  test('ignores float noise on a whole ratio', () => {
    expect(wholeDevicePixelRatio(2.0000000298023224)).toBe(2);
    expect(wholeDevicePixelRatio(1.0000000149011612)).toBe(1);
  });

  test('never goes below 1', () => {
    expect(wholeDevicePixelRatio(0.5)).toBe(1);
    expect(wholeDevicePixelRatio(0)).toBe(1);
    expect(wholeDevicePixelRatio(undefined)).toBe(1);
  });

  test('keeps the backing store a whole number of pixels', () => {
    const dpr = wholeDevicePixelRatio(1.36);
    expect(Number.isInteger(80 * 9 * dpr)).toBe(true);
  });
});

/** A window whose resolution queries can be fired by hand. */
function fakeWindow(ratio: number) {
  const queries: { media: string; listeners: Set<() => void> }[] = [];
  const win = {
    devicePixelRatio: ratio,
    matchMedia(media: string) {
      const query = { media, listeners: new Set<() => void>() };
      queries.push(query);
      return {
        addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
      } as unknown as MediaQueryList;
    },
  };
  const change = (next: number) => {
    const query = queries[queries.length - 1];
    win.devicePixelRatio = next;
    for (const listener of [...query.listeners]) {
      query.listeners.delete(listener);
      listener();
    }
  };
  return { win, queries, change };
}

describe('watchDevicePixelRatio', () => {
  test('watches the current ratio', () => {
    const { win, queries } = fakeWindow(2);
    watchDevicePixelRatio(win, () => {});
    expect(queries.map((q) => q.media)).toEqual(['(resolution: 2dppx)']);
  });

  test('reports each change and re-arms for the new ratio', () => {
    const { win, queries, change } = fakeWindow(2);
    const seen: number[] = [];
    watchDevicePixelRatio(win, (ratio) => seen.push(ratio));
    change(1);
    change(1.25);
    expect(seen).toEqual([1, 1.25]);
    expect(queries.map((q) => q.media)).toEqual([
      '(resolution: 2dppx)',
      '(resolution: 1dppx)',
      '(resolution: 1.25dppx)',
    ]);
  });

  test('stops reporting once stopped', () => {
    const { win, queries, change } = fakeWindow(2);
    const seen: number[] = [];
    const stop = watchDevicePixelRatio(win, (ratio) => seen.push(ratio));
    change(1);
    stop();
    expect(queries[queries.length - 1].listeners.size).toBe(0);
    change(2);
    expect(seen).toEqual([1]);
  });
});

/** A cell whose codepoint records its row and column. */
function cellAt(y: number, x: number): GhosttyCell {
  return {
    codepoint: y * 100 + x,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

describe('frameLines', () => {
  const cols = 3;
  const rows = 2;
  const viewport = [0, 1].flatMap((y) => [0, 1, 2].map((x) => cellAt(y, x)));

  test('reads the viewport once per frame and slices rows from it', () => {
    let reads = 0;
    let lineReads = 0;
    const buffer = {
      getViewport: () => {
        reads++;
        return viewport;
      },
      getLine: () => {
        lineReads++;
        return null;
      },
    };
    const getLine = frameLines(buffer, cols, rows);
    expect(reads).toBe(0);
    expect(getLine(1)?.map((c) => c.codepoint)).toEqual([100, 101, 102]);
    expect(getLine(0)?.map((c) => c.codepoint)).toEqual([0, 1, 2]);
    expect(getLine(1)?.map((c) => c.codepoint)).toEqual([100, 101, 102]);
    expect(reads).toBe(1);
    expect(lineReads).toBe(0);
    frameLines(buffer, cols, rows)(0);
    expect(reads).toBe(2);
  });

  test('returns null outside the viewport', () => {
    const getLine = frameLines({ getViewport: () => viewport, getLine: () => null }, cols, rows);
    expect(getLine(-1)).toBeNull();
    expect(getLine(rows)).toBeNull();
  });

  test('falls back to getLine without getViewport', () => {
    const getLine = frameLines({ getLine: (y) => [cellAt(y, 0)] }, cols, rows);
    expect(getLine(1)?.[0].codepoint).toBe(100);
  });

  test('serves the same rows as getLine from a real terminal', async () => {
    const ghostty = await Ghostty.load(WASM);
    const term = ghostty.createTerminal(20, 5);
    term.write('\x1b[31mred\x1b[0m \x1b[1;44mbold\x1b[0m\r\n中文 ✓\r\n\x1b[7mrev\x1b[0m');
    term.update();
    const getLine = frameLines(term, 20, 5);
    for (let y = 0; y < 5; y++) {
      expect(getLine(y)).toEqual(term.getLine(y));
    }
    term.free();
  });
});

/** A 2D context that records the text drawn on each canvas row. */
function recordingCanvas(cellHeight: number) {
  const drawn = new Map<number, string[]>();
  const ctx = new Proxy(
    {
      fillText: (text: string, _x: number, y: number) => {
        const row = Math.floor(y / cellHeight);
        drawn.set(row, [...(drawn.get(row) ?? []), text]);
      },
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    } as Record<string | symbol, unknown>,
    { get: (t, k) => (k in t ? t[k] : () => undefined), set: () => true },
  );
  const canvas = {
    getContext: () => ctx,
    style: {},
    dataset: {},
    width: 0,
    height: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, drawn };
}

describe('graphemes while scrolled', () => {
  test(`draws scrollback graphemes from their own row`, async () => {
    const doc = globalThis.document;
    const { canvas, drawn } = recordingCanvas(15);
    globalThis.document = { createElement: () => canvas } as unknown as Document;
    try {
      const ghostty = await Ghostty.load(WASM);
      const term = ghostty.createTerminal(30, 6, { scrollbackLines: 10000 });
      // A grapheme at a different column on every line, so a lookup on the wrong
      // row finds something else.
      for (let i = 0; i < 20; i++) term.write(`${'x'.repeat(i % 7)}e\u0301 ${i}\r\n`);
      term.write('$ abcdefghijklmnop');
      const sb = term.getScrollbackLength();
      const provider = {
        getScrollbackLine: (o: number) => term.getScrollbackLine(o),
        getScrollbackLength: () => sb,
        getScrollbackGraphemeString: (o: number, c: number) =>
          term.getScrollbackGraphemeString(o, c),
      };
      const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1, overscan: 1 });
      renderer.resize(30, 6);
      renderer.render(term, true, 3, provider);
      // Below the overscan row, canvas rows 1-3 show the last three scrollback lines
      // (line i is the i-th written); rows 4-6 the top of the screen.
      for (let row = 0; row < 3; row++) {
        expect(drawn.get(row + 1)).toContain('e\u0301');
        expect(drawn.get(row + 1)?.join('')).toContain(` ${sb - 3 + row} `);
      }
      expect(drawn.get(4)).toContain('e\u0301');
      term.free();
    } finally {
      globalThis.document = doc;
    }
  });
});

/**
 * A 2D context that rasterises into one string per device pixel: enough of canvas to
 * compare a partial frame with a full redraw. Glyphs fill their cell; a combining acute
 * also covers the bottom of the row above and a `g` the top of the row below, like
 * glyphs that overflow their cell. Like Chrome, a glyph whose cell lies outside the clip
 * is not drawn at all, even where its overflow reaches into the clip. A translucent
 * `rgba()` fill blends over what is there, so drawing it twice differs from drawing it
 * once. `lose()` blanks the canvas and resets the context, as a lost and restored
 * context does.
 */
function rasterCanvas() {
  type Rect = [number, number, number, number];
  interface State {
    m: [number, number, number, number];
    clip: Rect | null;
    fillStyle: string;
    strokeStyle: string;
    font: string;
    globalAlpha: number;
    globalCompositeOperation: string;
  }
  let width = 0;
  let height = 0;
  let pixels: string[] = [];
  const fresh = (): State => ({
    m: [1, 1, 0, 0],
    clip: null,
    fillStyle: '#000',
    strokeStyle: '#000',
    font: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  });
  let st = fresh();
  let stack: State[] = [];
  let path: Rect | null = null;
  let line: number[] = [];
  const reset = () => {
    pixels = new Array(width * height).fill('');
    st = fresh();
    stack = [];
  };
  const device = (x: number, y: number, w: number, h: number): Rect => {
    const [sx, sy, tx, ty] = st.m;
    return [x * sx + tx, y * sy + ty, (x + w) * sx + tx, (y + h) * sy + ty].map(Math.round) as Rect;
  };
  const paint = ([x0, y0, x1, y1]: Rect, value: string) => {
    const c = st.clip ?? [0, 0, width, height];
    const blends = value.startsWith('rgba(');
    for (let y = Math.max(y0, c[1], 0); y < Math.min(y1, c[3], height); y++) {
      for (let x = Math.max(x0, c[0], 0); x < Math.min(x1, c[2], width); x++) {
        const i = y * width + x;
        pixels[i] = blends ? `${pixels[i]} + ${value}` : value;
      }
    }
  };
  const ink = (style: string) => (st.globalAlpha === 1 ? style : `${style}@${st.globalAlpha}`);
  const ctx = new Proxy(
    {
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
      save: () => stack.push({ ...st, m: [...st.m] }),
      restore: () => {
        st = stack.pop() ?? st;
      },
      scale: (x: number, y: number) => {
        st.m = [st.m[0] * x, st.m[1] * y, st.m[2], st.m[3]];
      },
      setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
        st.m = [a, d, e, f];
      },
      clearRect: (x: number, y: number, w: number, h: number) => paint(device(x, y, w, h), ''),
      fillRect: (x: number, y: number, w: number, h: number) =>
        paint(device(x, y, w, h), ink(st.fillStyle)),
      fillText: (text: string, x: number, y: number) => {
        const cell = device(x, y - 11, 8, 15);
        if (st.clip && (cell[3] <= st.clip[1] || cell[1] >= st.clip[3])) return;
        const up = text.includes('́') ? 4 : 0;
        const down = text === 'g' ? 4 : 0;
        paint(device(x, y - 11 - up, 8, 15 + up + down), ink(`${st.fillStyle} ${st.font} ${text}`));
      },
      beginPath: () => {
        path = null;
        line = [];
      },
      rect: (x: number, y: number, w: number, h: number) => {
        path = device(x, y, w, h);
      },
      clip: () => {
        const c = st.clip ?? [0, 0, width, height];
        const p = path ?? c;
        st.clip = [
          Math.max(c[0], p[0]),
          Math.max(c[1], p[1]),
          Math.min(c[2], p[2]),
          Math.min(c[3], p[3]),
        ];
      },
      moveTo: (x: number, y: number) => {
        line = [x, y];
      },
      lineTo: (x: number) => {
        line = [line[0], line[1], x];
      },
      stroke: () =>
        paint(device(line[0], line[1] - 0.5, line[2] - line[0], 1), `line ${st.strokeStyle}`),
      drawImage: (
        src: { pixels: string[]; width: number },
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
      ) => {
        expect(st.m).toEqual([1, 1, 0, 0]);
        const from = [...src.pixels];
        if (st.globalCompositeOperation === 'copy') paint([0, 0, width, height], '');
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            pixels[(dy + y) * width + dx + x] = from[(sy + y) * src.width + sx + x];
          }
        }
      },
    } as Record<string | symbol, unknown>,
    {
      get: (t, k) => (k in t ? t[k] : k in st ? st[k as keyof State] : () => undefined),
      set: (_t, k, v) => {
        if (k in st) (st as unknown as Record<string | symbol, unknown>)[k] = v;
        return true;
      },
    },
  );
  const restored = new Set<() => void>();
  const canvas = {
    getContext: () => ctx,
    style: {},
    dataset: {},
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'contextrestored') restored.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'contextrestored') restored.delete(listener);
    },
    get pixels() {
      return pixels;
    },
    get width() {
      return width;
    },
    set width(w: number) {
      width = w;
      reset();
    },
    get height() {
      return height;
    },
    set height(h: number) {
      height = h;
      reset();
    },
  };
  const lose = () => {
    reset();
    for (const listener of restored) listener();
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, pixels: () => pixels, lose };
}

describe('overscan and copied scrolls (ADR 043)', () => {
  const cols = 30;
  const rows = 8;

  /** A fresh renderer on its own raster canvas, counting the rows it draws and its copies. */
  function renderer(dpr: number, options: ConstructorParameters<typeof CanvasRenderer>[1] = {}) {
    const element = rasterCanvas();
    const created: ReturnType<typeof rasterCanvas>[] = [];
    const doc = globalThis.document;
    // The canvas the renderer draws on is the first it creates. The others (scratch, font
    // measuring) rasterise on their own.
    globalThis.document = {
      createElement: () => {
        const canvas = rasterCanvas();
        created.push(canvas);
        return canvas.canvas;
      },
    } as unknown as Document;
    try {
      const r = new CanvasRenderer(element.canvas, { ...options, devicePixelRatio: dpr });
      const raster = created[0];
      r.resize(cols, rows);
      const drawn: number[] = [];
      let copies = 0;
      const internals = r as unknown as {
        renderLine: (...args: unknown[]) => void;
        shiftRows: (...args: unknown[]) => void;
      };
      const renderLine = internals.renderLine.bind(r);
      internals.renderLine = (...args: unknown[]) => {
        drawn.push(args[1] as number);
        renderLine(...args);
      };
      const shiftRows = internals.shiftRows.bind(r);
      internals.shiftRows = (...args: unknown[]) => {
        copies++;
        shiftRows(...args);
      };
      /** The device pixels the element shows. */
      const shown = () => {
        const { y, height } = r.visibleArea;
        const width = raster.canvas.width;
        return raster.pixels().slice(y * width, (y + height) * width);
      };
      /** The device pixels of the line the bottom edge strip stretches. */
      const lastLine = () => {
        const width = raster.canvas.width;
        const y = r.visibleArea.lastLine;
        return raster.pixels().slice(y * width, (y + 1) * width);
      };
      return { r, shown, lastLine, lose: raster.lose, drawn, copies: () => copies };
    } finally {
      globalThis.document = doc;
    }
  }

  /** Splits a fractional position into viewportY and an offset snapped to device pixels. */
  function split(position: number, cellHeight: number, dpr: number) {
    const line = Math.floor(position);
    const offset = Math.round((position - line) * cellHeight * dpr) / dpr;
    return offset >= cellHeight ? { line: line + 1, offset: 0 } : { line, offset };
  }

  async function terminal() {
    const ghostty = await Ghostty.load(WASM);
    const term = ghostty.createTerminal(cols, rows, { scrollbackLines: 10000 });
    // Colours, backgrounds, a wide character, combining marks and descenders that
    // overflow into the rows above and below.
    for (let i = 0; i < 40; i++) {
      term.write(
        i % 3 === 0
          ? `\x1b[3${i % 8}mline ${i} e\u0301 g\x1b[0m\r\n`
          : i % 3 === 1
            ? `\x1b[4${i % 8}m bg ${i} \x1b[0m 中 g\r\n`
            : `plain ${i} a\u0301\r\n`,
      );
      // OSC 8 links, two lines each
      if (i % 7 === 0)
        term.write(`\x1b]8;;https://x/${i % 2}\x1b\\link ${i}\r\nmore g\x1b]8;;\x1b\\\r\n`);
    }
    // The cursor mid-screen, so a scroll moves it onto another row in view.
    term.write('$ prompt\x1b[5;3H');
    const sb = term.getScrollbackLength();
    const provider = {
      getScrollbackLine: (o: number) => term.getScrollbackLine(o),
      getScrollbackLength: () => sb,
      getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
    };
    return { term, provider };
  }

  type Term = Awaited<ReturnType<typeof terminal>>;

  /**
   * What the previous renderer showed at a position, drawn independently: the viewport
   * as a screen of its own lines, nothing below it, and at a fraction of a line the
   * bottom of the line above drawn on its own (ADR 040's strip). No scrollbar.
   */
  function previous({ term, provider }: Term, view: number, offset: number, dpr: number) {
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
      const t = renderer(dpr);
      t.r.resize(cols, count);
      t.r.render(
        {
          getLine: (y) => lines[y]?.line ?? null,
          getGraphemeString: (y, c) => lines[y].grapheme(c),
          getCursor: () => (cursor ? term.getCursor() : { x: 0, y: 0, visible: false }),
          getDimensions: () => ({ cols, rows: count }),
          isRowDirty: () => false,
          clearDirty: () => {},
        },
        true,
        0,
      );
      return t.shown();
    };
    const width = cols * 8 * dpr;
    const cut = offset * dpr * width;
    const viewport = screen(0, rows, view === 0);
    if (!offset) return viewport;
    const above = screen(-1, 1, false);
    return [...above.slice(above.length - cut), ...viewport.slice(0, viewport.length - cut)];
  }

  test(`the rows in view equal the previous renderer at every position`, async () => {
    const t = await terminal();
    const sb = t.provider.getScrollbackLength();
    for (const [dpr, overscan] of [
      [1, 3],
      [2, 1],
      [2, 2],
      [2, undefined],
    ] as const) {
      const live = renderer(dpr, { overscan });
      const h = live.r.getMetrics().height;
      live.r.render(t.term, true, 0, t.provider, 0);
      // Trackpad steps up and down, a jump past the overscan, line steps, the top
      const positions = [
        ...Array.from({ length: 24 }, (_, i) => i * 0.35),
        18.6,
        15.4,
        ...Array.from({ length: 12 }, (_, i) => 15.4 - i * 0.45),
        1,
        2,
        5,
        4,
        0,
        3,
        10,
        9,
        17,
        16,
        0.5,
        0,
        sb,
        sb - 0.25,
        sb - 7.75,
        0,
      ];
      for (const p of positions) {
        const { line, offset } = split(p, h, dpr);
        live.r.setScrollOffset(offset);
        live.r.render(t.term, false, line, t.provider, 0);
        expect(live.r.scrollOffset).toBe(offset);
        expect(live.shown()).toEqual(previous(t, line, offset, dpr));
        // The bottom strip's line is the last row's own, at any fraction: not the
        // glyphs the part in view ends on, offset above it.
        const area = live.r.visibleArea;
        expect(area.lastLine).toBe(area.y + area.height - 1 + offset * dpr);
        const whole = previous(t, line, 0, dpr);
        expect(live.lastLine()).toEqual(whole.slice(whole.length - cols * 8 * dpr));
      }
    }
    t.term.free();
  });

  test(`an offset set for a taller cell shows at most a line`, async () => {
    const t = await terminal();
    const live = renderer(2);
    const h = live.r.getMetrics().height;
    live.r.setScrollOffset(h + 6);
    live.r.render(t.term, true, 3, t.provider, 0);
    expect(live.r.scrollOffset).toBe(h - 0.5);
    expect(live.shown()).toEqual(previous(t, 3, h - 0.5, 2));
    t.term.free();
  });

  test(`random scrolls, output, selection, hover and scrollbar equal a full redraw`, async () => {
    const { term } = await terminal();
    const provider = {
      getScrollbackLine: (o: number) => term.getScrollbackLine(o),
      getScrollbackLength: () => term.getScrollbackLength(),
      getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
    };
    // A fixed pseudo-random sequence
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let view = 0;
    let selection: {
      startCol: number;
      startLine: number;
      endCol: number;
      endLine: number;
    } | null = null;
    const manager = {
      hasSelection: () => selection !== null,
      getSelectionRange: () => {
        if (!selection) return null;
        const sb = term.getScrollbackLength();
        return {
          startCol: selection.startCol,
          startRow: selection.startLine - sb + view,
          endCol: selection.endCol,
          endRow: selection.endLine - sb + view,
        };
      },
    } as unknown as Parameters<CanvasRenderer['setSelectionManager']>[0];
    let range: { startX: number; startY: number; endX: number; endY: number } | null = null;
    for (const overscan of [1, 3]) {
      const options = { overscan };
      const live = renderer(2, options);
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
          term.write(i % 2 ? `out ${i} e\u0301 g\r\n` : `\x1b[4${i % 8}m${i}\x1b[0m \u4e2d g`);
        } else if (op < 0.7) opacity = opacity ? 0 : 1;
        else if (op < 0.8) {
          const line = Math.floor(random() * (sb + rows));
          selection =
            random() < 0.3
              ? null
              : {
                  startCol: Math.floor(random() * cols),
                  startLine: line,
                  endCol: Math.floor(random() * cols),
                  endLine: line + Math.floor(random() * 6),
                };
        } else {
          const y = Math.floor(random() * rows);
          range = random() < 0.3 ? null : { startX: 2, startY: y, endX: 6, endY: y };
        }
        position = Math.max(0, Math.min(term.getScrollbackLength(), position));
        const { line, offset } = split(position, h, 2);
        view = line;
        live.r.setHoveredLinkRange(range);
        live.r.setScrollOffset(offset);
        live.r.render(term, false, view, provider, opacity);
        const full = renderer(2, options);
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
    const ghostty = await Ghostty.load(WASM);
    const term = ghostty.createTerminal(cols, tall, { scrollbackLines: 10000 });
    const provider = {
      getScrollbackLine: (o: number) => term.getScrollbackLine(o),
      getScrollbackLength: () => term.getScrollbackLength(),
      getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
    };
    // Every line overflows into the rows above and below, so each chunk's edges matter
    const lines = (from: number, count: number) =>
      Array.from(
        { length: count },
        (_, i) => `\x1b[4${(from + i) % 8}m${from + i} e\u0301 g\x1b[0m`,
      );
    term.write(lines(0, tall * 2).join('\r\n'));
    for (const overscan of [1, 4]) {
      const live = renderer(2, { overscan });
      live.r.resize(cols, tall);
      const scratch = (live.r as unknown as { scratch: HTMLCanvasElement }).scratch;
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
        const full = renderer(2, { overscan });
        full.r.resize(cols, tall);
        full.r.render(term, true, y, provider, 1);
        expect(live.shown()).toEqual(full.shown());
        expect(scratch.height).toBeLessThanOrEqual((REPAINT_CHUNK_ROWS + 1) * rowHeight);
      }
    }
    term.free();
  });

  test('visibleArea.version moves when the canvas is drawn on and not on an idle frame', async () => {
    const t = await terminal();
    const live = renderer(2);
    live.r.render(t.term, true, 0, t.provider, 0);
    live.r.render(t.term, false, 0, t.provider, 0);
    const idle = live.r.visibleArea.version;
    // Nothing changed: the edge strips may skip their copy.
    live.r.render(t.term, false, 0, t.provider, 0);
    expect(live.r.visibleArea.version).toBe(idle);
    // Output, and a scroll, draw on the canvas.
    t.term.write('more output\r\n');
    live.r.render(t.term, false, 0, t.provider, 0);
    const afterOutput = live.r.visibleArea.version;
    expect(afterOutput).toBeGreaterThan(idle);
    live.r.render(t.term, false, 3, t.provider, 0);
    expect(live.r.visibleArea.version).toBeGreaterThan(afterOutput);
    t.term.free();
  });

  test(`a hovered OSC 8 link underlines and repaints only its own range`, async () => {
    const ghostty = await Ghostty.load(WASM);
    const term = ghostty.createTerminal(cols, rows);
    // Two links, on rows 1 and 4: the engine gives every link cell the same hyperlink_id
    term.write('a\r\n\x1b]8;;https://a/\x1b\\first\x1b]8;;\x1b\\\r\nb\r\nc\r\n');
    term.write('\x1b]8;;https://b/\x1b\\second\x1b]8;;\x1b\\');
    expect(term.getLine(1)?.[0].hyperlink_id).toBe(term.getLine(4)?.[0].hyperlink_id);
    const live = renderer(1, { overscan: 2 });
    live.r.render(term, true, 0, undefined, 0);
    live.drawn.length = 0;
    live.r.setHoveredLinkRange({ startX: 0, startY: 4, endX: 5, endY: 4 });
    live.r.render(term, false, 0, undefined, 0);
    // The hovered row, the row above it, which may hold its overflow, and the row below,
    // which overflows into it (overscan rows first)
    expect([...new Set(live.drawn)].sort()).toEqual([3, 4, 5].map((y) => y + 2));
    const width = cols * 8;
    const underlined = (y: number) =>
      live
        .shown()
        .slice(y * 15 * width, (y + 1) * 15 * width)
        .some((p) => p.startsWith('line #4A90E2'));
    expect([0, 1, 2, 3, 4, 5].map(underlined)).toEqual([false, false, false, false, true, false]);
    term.free();
  });

  test(`rows out of view follow output at the bottom`, async () => {
    const { term } = await terminal();
    const provider = {
      getScrollbackLine: (o: number) => term.getScrollbackLine(o),
      getScrollbackLength: () => term.getScrollbackLength(),
      getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
    };
    const live = renderer(2, { overscan: 4 });
    live.r.render(term, true, 0, provider, 0);
    // Draw the rows above the viewport, return, and let output (a new line, then a line
    // changed in place) move the lines they show
    for (const output of [
      '\x1b[8;1H\r\nnew line e\u0301 g',
      '\rsame line g\x1b[K',
      '\r\n\x1b[41m\u4e2d\u4e2d\x1b[0m',
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
        expect(live.shown()).toEqual(previous({ term, provider }, y, offset, 2));
      }
      live.r.setScrollOffset(0);
    }
    term.free();
  });

  test(`a scroll draws only the rows that came into view and the edges`, async () => {
    const t = await terminal();
    const live = renderer(2, { overscan: 6 });
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
      const { line, offset } = split(p, h, 2);
      live.r.setScrollOffset(offset);
      live.r.render(t.term, false, line, t.provider, 1);
    }
    const copies = live.copies();
    const before = live.drawn.length;
    for (let p = 4; p >= 1; p -= 0.25) {
      const { line, offset } = split(p, h, 2);
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

  test(`a scrolled frame with nothing changed draws no row`, async () => {
    const { term, provider } = await terminal();
    const live = renderer(2);
    live.r.render(term, true, 0, provider, 1);
    live.r.render(term, false, 6, provider, 1);
    const before = live.drawn.length;
    for (let i = 0; i < 3; i++) live.r.render(term, false, 6, provider, 1);
    expect(live.drawn.length).toBe(before);
    // Dropping the scrollbar repaints the rows in view, so none keeps the thumb.
    live.r.render(term, false, 6, provider, 0);
    expect(live.drawn.length - before).toBe(rows);
    const full = renderer(2);
    full.r.render(term, true, 6, provider, 0);
    expect(live.shown()).toEqual(full.shown());
    term.free();
  });

  test(`selection, link underline and cursor follow a scroll`, async () => {
    const { term, provider } = await terminal();
    const sb = provider.getScrollbackLength();
    let view = 0;
    // A selection anchored to buffer lines, as SelectionManager keeps it, reaching past
    // the viewport.
    const first = { startCol: 3, startLine: sb - 4, endCol: 12, endLine: sb + 2 };
    const second = { startCol: 0, startLine: sb - 12, endCol: 4, endLine: sb - 9 };
    let selection = first;
    const manager = {
      hasSelection: () => true,
      getSelectionRange: () => ({
        startCol: selection.startCol,
        startRow: selection.startLine - sb + view,
        endCol: selection.endCol,
        endRow: selection.endLine - sb + view,
      }),
    } as unknown as Parameters<CanvasRenderer['setSelectionManager']>[0];
    const range = { startX: 2, startY: 6, endX: 9, endY: 6 };
    for (const overscan of [1, 4]) {
      const options = { overscan, theme: { cursor: 'rgba(255, 0, 0, 0.3)' } };
      const live = renderer(2, options);
      live.r.setSelectionManager(manager);
      live.r.setHoveredLinkRange(range);
      live.r.render(term, true, 0, provider, 1);
      selection = first;
      for (const [y, offset, changed] of [
        [1, 0],
        [3, 0],
        [3, 7.5],
        [2, 0.5],
        [0, 4],
        [0, 0],
        [2, 3],
        [7, 0],
        [9, 1],
        [6, 0],
        [6, 0, second],
        [6, 2],
        [11, 0],
        // The selection changes on a frame that copies rows, with the old one still in view
        [13, 0, first],
        [12, 0, second],
        [5, 3, first],
        [0, 0],
      ] as const) {
        if (changed) selection = changed;
        view = y;
        live.r.setScrollOffset(offset);
        live.r.render(term, false, view, provider, 1);
        const full = renderer(2, options);
        full.r.setSelectionManager(manager);
        full.r.setHoveredLinkRange(range);
        full.r.setScrollOffset(offset);
        full.r.render(term, true, view, provider, 1);
        expect(live.shown()).toEqual(full.shown());
      }
    }
    term.free();
  });

  test(`search highlights follow scrolls, output and selection changes (ADR 055)`, async () => {
    const { term, provider } = await terminal();
    const sb = () => term.getScrollbackLength();
    const live = { provider: { ...provider, getScrollbackLength: sb } };
    term.setSearch('g');
    while (term.searchStep(50)) {}
    const read = () => ({ matches: term.searchMatches(), selected: term.searchSelectedMatch() });
    let highlights = read();
    expect(highlights.matches.length).toBeGreaterThan(40);
    for (const overscan of [1, 4]) {
      const r = renderer(2, { overscan });
      r.r.setSearchHighlights(highlights);
      r.r.render(term, true, 0, live.provider, 0);
      const steps: [number, number, (() => void)?][] = [
        [0, 0],
        [3, 0, () => term.searchSelect('next')],
        [3, 7.5],
        [9, 0, () => term.searchSelect('next')],
        [12, 0],
        [6, 2, () => term.searchSelect('previous')],
        [0, 0, () => term.write('one more g\r\n')],
        [2, 0],
        [2, 0, () => term.setSearch('plain')],
        [0, 0, () => term.setSearch('')],
      ];
      for (const [view, offset, change] of steps) {
        if (change) {
          change();
          while (term.searchStep(50)) {}
          highlights = read();
          r.r.setSearchHighlights(highlights.matches.length ? highlights : null);
        }
        r.r.setScrollOffset(offset);
        r.r.render(term, false, view, live.provider, 0);
        const full = renderer(2, { overscan });
        full.r.setSearchHighlights(highlights.matches.length ? highlights : null);
        full.r.setScrollOffset(offset);
        full.r.render(term, true, view, live.provider, 0);
        expect(r.shown()).toEqual(full.shown());
      }
      term.setSearch('g');
      while (term.searchStep(50)) {}
      highlights = read();
    }
    // The matches' text in the search colours, the selected one's in its own
    const r = renderer(1, {
      theme: { searchForeground: '#111111', searchSelectedForeground: '#222222' },
    });
    term.searchSelect('next');
    r.r.setSearchHighlights(read());
    r.r.render(term, true, 0, live.provider, 0);
    const glyphs = (color: string) => r.shown().filter((v) => v.startsWith(`${color} `));
    expect(glyphs('#111111').length).toBeGreaterThan(0);
    expect(glyphs('#222222').length).toBeGreaterThan(0);
    term.free();
  });

  test(`a translucent cursor drawn again is not blended over itself`, async () => {
    const { term, provider } = await terminal();
    const theme = { cursor: 'rgba(255, 0, 0, 0.3)' };
    // The shape is the engine's (ADR 049)
    for (const [cursorStyle, ps] of [
      ['block', 2],
      ['bar', 6],
      ['underline', 4],
    ] as const) {
      term.write(`\x1b[${ps} q`);
      const live = renderer(2, { theme, cursorStyle });
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
        const full = renderer(2, { theme, cursorStyle });
        full.r.render(term, true, y, provider, 1);
        expect(live.shown()).toEqual(full.shown());
      }
      live.r.dispose();
    }
    term.free();
  });

  test(`draws the cursor shape the engine reports, not the configured one (ADR 049)`, async () => {
    const { term, provider } = await terminal();
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
    const live = renderer(2, { cursorStyle: 'block' });
    live.r.render(term, true, 0, provider, 1);
    const underline = renderer(2, { cursorStyle: 'underline' });
    underline.r.render(optionShape, true, 0, provider, 1);
    expect(live.shown()).toEqual(underline.shown());
    // A later DECSCUSR repaints the cursor cell on the next frame
    term.write('\x1b[6 q');
    live.r.render(term, false, 0, provider, 1);
    const bar = renderer(2, { cursorStyle: 'bar' });
    bar.r.render(optionShape, true, 0, provider, 1);
    expect(live.shown()).toEqual(bar.shown());
    expect(live.shown()).not.toEqual(underline.shown());
    term.free();
  });

  test(`the block cursor redraws the grapheme of its own screen row`, async () => {
    const ghostty = await Ghostty.load(WASM);
    const term = ghostty.createTerminal(cols, rows, { scrollbackLines: 10000 });
    // Every row starts with a cluster of its own, the cursor on a combining one
    term.write(
      Array.from({ length: rows }, (_, i) => `${'abcdefgh'[i]}\u0301\u0302 ${i}`).join('\r\n'),
    );
    term.write('\x1b[3;1H');
    const provider = {
      getScrollbackLine: (o: number) => term.getScrollbackLine(o),
      getScrollbackLength: () => term.getScrollbackLength(),
      getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
    };
    const live = renderer(2, { cursorStyle: 'block' });
    const internals = live.r as unknown as { renderCellText: (...args: unknown[]) => void };
    const renderCellText = internals.renderCellText.bind(live.r);
    const accented: string[] = [];
    internals.renderCellText = (...args: unknown[]) => {
      // The cursor draws its character in the accent colour
      if (args[3] !== undefined) accented.push((args[4] as (col: number) => string)(0));
      renderCellText(...args);
    };
    live.r.render(term, true, 0, provider, 1);
    expect(accented).toEqual([term.getGraphemeString(2, 0)]);
    expect(accented[0]).toBe('c\u0301\u0302');
    live.r.dispose();
    term.free();
  });

  test(`a restored context is repainted on the next frame`, async () => {
    const { term, provider } = await terminal();
    for (const y of [6, 0]) {
      const live = renderer(2);
      live.r.render(term, true, 0, provider, 1);
      live.r.render(term, false, y, provider, 1);
      live.lose();
      live.r.render(term, false, y, provider, 1);
      const full = renderer(2);
      full.r.render(term, true, y, provider, 1);
      expect(live.shown()).toEqual(full.shown());
      // Disposed, it no longer listens
      live.r.dispose();
      live.lose();
      live.r.render(term, false, y, provider, 1);
      expect(live.shown()).not.toEqual(full.shown());
    }
    term.free();
  });
});
