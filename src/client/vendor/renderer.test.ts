import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import {
  CanvasRenderer,
  frameLines,
  watchDevicePixelRatio,
  wholeDevicePixelRatio,
} from './ghostty-web/renderer';
import type { GhosttyCell } from './ghostty-web/types';

const WASM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ghostty-web/ghostty-vt.wasm');
const OFFICIAL_WASM = path.join(
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
    width: 0,
    height: 0,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, drawn };
}

describe('graphemes while scrolled', () => {
  for (const [engine, wasm] of [
    ['coder', WASM],
    ['official', OFFICIAL_WASM],
  ] as const) {
    test(`draws scrollback graphemes from their own row (${engine})`, async () => {
      const doc = globalThis.document;
      const { canvas, drawn } = recordingCanvas(15);
      globalThis.document = { createElement: () => canvas } as unknown as Document;
      try {
        const ghostty = await Ghostty.load(wasm, engine);
        const term = ghostty.createTerminal(30, 6, { scrollbackLimit: 10000 });
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
        const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1 });
        renderer.resize(30, 6);
        renderer.render(term, true, 3, provider);
        // Canvas rows 0-2 show the last three scrollback lines (line i is the i-th
        // written); rows 3-5 the top of the screen.
        for (let row = 0; row < 3; row++) {
          expect(drawn.get(row)).toContain('e\u0301');
          expect(drawn.get(row)?.join('')).toContain(` ${sb - 3 + row} `);
        }
        expect(drawn.get(3)).toContain('e\u0301');
        term.free();
      } finally {
        globalThis.document = doc;
      }
    });
  }
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

describe('whole-line scroll copies rows (ADR 043)', () => {
  const cols = 30;
  const rows = 8;

  /** A fresh renderer on its own raster canvas, counting the rows it draws. */
  function renderer(dpr: number, options: ConstructorParameters<typeof CanvasRenderer>[1] = {}) {
    const raster = rasterCanvas();
    const doc = globalThis.document;
    // Other canvases (font measuring, the scratch canvas) rasterise on their own
    globalThis.document = {
      createElement: () => rasterCanvas().canvas,
    } as unknown as Document;
    try {
      const r = new CanvasRenderer(raster.canvas, { ...options, devicePixelRatio: dpr });
      r.resize(cols, rows);
      const drawn: number[] = [];
      const internals = r as unknown as { renderLine: (...args: unknown[]) => void };
      const renderLine = internals.renderLine.bind(r);
      internals.renderLine = (...args: unknown[]) => {
        drawn.push(args[1] as number);
        renderLine(...args);
      };
      return { r, pixels: raster.pixels, lose: raster.lose, drawn };
    } finally {
      globalThis.document = doc;
    }
  }

  for (const [engine, wasm] of [
    ['coder', WASM],
    ['official', OFFICIAL_WASM],
  ] as const) {
    async function terminal() {
      const ghostty = await Ghostty.load(wasm, engine);
      const term = ghostty.createTerminal(cols, rows, { scrollbackLimit: 10000 });
      // Colours, backgrounds, a wide character, combining marks and descenders that
      // overflow into the rows above and below.
      for (let i = 0; i < 40; i++) {
        term.write(
          i % 3 === 0
            ? `\x1b[3${i % 8}mline ${i} é g\x1b[0m\r\n`
            : i % 3 === 1
              ? `\x1b[4${i % 8}m bg ${i} \x1b[0m 中 g\r\n`
              : `plain ${i} á\r\n`,
        );
      }
      // The cursor mid-screen, so a scroll moves it onto another row in view.
      term.write('$ prompt\x1b[5;3H');
      const sb = term.getScrollbackLength();
      const provider = {
        getScrollbackLine: (o: number) => term.getScrollbackLine(o),
        getScrollbackLength: () => sb,
        getScrollbackGraphemeString: (o: number, c: number) =>
          term.getScrollbackGraphemeString(o, c),
      };
      return { term, provider };
    }

    test(`each step draws only the rows that came into view and equals a full redraw (${engine})`, async () => {
      const { term, provider } = await terminal();
      for (const dpr of [1, 1.5]) {
        const live = renderer(dpr);
        live.r.render(term, true, 0, provider, 1);
        for (const y of [1, 2, 5, 4, 0, 3, 10, 9, 17, 16, 0, 1]) {
          const before = live.drawn.length;
          const from = (live.r as unknown as { lastViewportY: number }).lastViewportY;
          live.r.render(term, false, y, provider, 1);
          const steps = Math.abs(y - from);
          // The rows that came into view and the one their glyphs overflow into, the last
          // row (scrolling up) and the row the old cursor moved to with the row below it.
          expect(live.drawn.length - before).toBeLessThanOrEqual(steps + 4);
          const full = renderer(dpr);
          full.r.render(term, true, y, provider, 1);
          expect(live.pixels()).toEqual(full.pixels());
        }
      }
      term.free();
    });

    test(`a scrolled frame with nothing changed draws no row (${engine})`, async () => {
      const { term, provider } = await terminal();
      const live = renderer(2);
      live.r.render(term, true, 0, provider, 1);
      live.r.render(term, false, 6, provider, 1);
      const before = live.drawn.length;
      for (let i = 0; i < 3; i++) live.r.render(term, false, 6, provider, 1);
      expect(live.drawn.length).toBe(before);
      // Dropping the scrollbar repaints every row, so none keeps the thumb.
      live.r.render(term, false, 6, provider, 0);
      expect(live.drawn.length - before).toBe(rows);
      const full = renderer(2);
      full.r.render(term, true, 6, provider, 0);
      expect(live.pixels()).toEqual(full.pixels());
      term.free();
    });

    test(`selection, link underline and cursor follow a copied scroll (${engine})`, async () => {
      const { term, provider } = await terminal();
      const sb = provider.getScrollbackLength();
      let view = 0;
      // A selection anchored to buffer lines, as SelectionManager keeps it.
      const selection = {
        hasSelection: () => true,
        getSelectionCoords: () => ({
          startCol: 3,
          startRow: sb - 4 - sb + view,
          endCol: 12,
          endRow: sb - 2 - sb + view,
        }),
        getDirtySelectionRows: () => new Set<number>(),
        clearDirtySelectionRows: () => {},
      } as unknown as Parameters<CanvasRenderer['setSelectionManager']>[0];
      const range = { startX: 2, startY: 3, endX: 9, endY: 3 };
      const live = renderer(2);
      live.r.setSelectionManager(selection);
      live.r.setHoveredLinkRange(range);
      live.r.render(term, true, 0, provider, 1);
      for (const y of [1, 3, 2, 0, 2, 7, 6]) {
        view = y;
        live.r.render(term, false, y, provider, 1);
        const full = renderer(2);
        full.r.setSelectionManager(selection);
        full.r.setHoveredLinkRange(range);
        full.r.render(term, true, y, provider, 1);
        expect(live.pixels()).toEqual(full.pixels());
      }
      term.free();
    });

    test(`a translucent cursor drawn again is not blended over itself (${engine})`, async () => {
      const { term, provider } = await terminal();
      const theme = { cursor: 'rgba(255, 0, 0, 0.3)' };
      for (const cursorStyle of ['block', 'bar', 'underline'] as const) {
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
          expect(live.pixels()).toEqual(full.pixels());
        }
        live.r.dispose();
      }
      term.free();
    });

    test(`a restored context is repainted on the next frame (${engine})`, async () => {
      const { term, provider } = await terminal();
      for (const y of [6, 0]) {
        const live = renderer(2);
        live.r.render(term, true, 0, provider, 1);
        live.r.render(term, false, y, provider, 1);
        live.lose();
        live.r.render(term, false, y, provider, 1);
        const full = renderer(2);
        full.r.render(term, true, y, provider, 1);
        expect(live.pixels()).toEqual(full.pixels());
        // Disposed, it no longer listens
        live.r.dispose();
        live.lose();
        live.r.render(term, false, y, provider, 1);
        expect(live.pixels()).not.toEqual(full.pixels());
      }
      term.free();
    });
  }
});
