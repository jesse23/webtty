// Canvas fakes for the renderer tests (test support, ADR 064): a context that records the
// text drawn per row, and one that rasterises into a string per device pixel, so a partial
// frame can be compared with a full redraw pixel for pixel.

import { expect } from 'bun:test';

/** The cell height the fake glyph box gives (10 px ascent + 3 px descent + 2 px padding). */
export const CELL_HEIGHT = 15;

/** A 2D context that records the text drawn on each canvas row. */
export function recordingCanvas(cellHeight: number = CELL_HEIGHT) {
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

/**
 * What the renderer did on the canvases sharing one log: the canvas rows it painted a line
 * on, in order (a row's own clear followed by its text; blank rows past the buffer's ends
 * are not lines), and the copied scrolls (drawImage with the 'copy' operator).
 */
export interface DrawLog {
  rows: number[];
  copies: number;
}

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

/**
 * A 2D context that rasterises into one string per device pixel: enough of canvas to
 * compare a partial frame with a full redraw. Glyphs fill their cell; a combining acute
 * also covers the bottom of the row above and a `g` the top of the row below, like
 * glyphs that overflow their cell. Like Chrome, a glyph whose cell lies outside the clip
 * is not drawn at all, even where its overflow reaches into the clip. A translucent
 * `rgba()` fill blends over what is there, so drawing it twice differs from drawing it
 * once. `lose()` blanks the canvas and resets the context, as a lost and restored
 * context does. Lines painted and copies are added to `log`.
 */
export function rasterCanvas(log: DrawLog = { rows: [], copies: 0 }) {
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
      clearRect: (x: number, y: number, w: number, h: number) => {
        // A row repaint starts with the row's own clear, outside save() (a cursor draws inside
        // it); a blank row draws no text after it
        if (stack.length === 0 && x === 0 && h === CELL_HEIGHT) log.rows.push(y / CELL_HEIGHT);
        paint(device(x, y, w, h), '');
      },
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
        if (st.globalCompositeOperation === 'copy') {
          log.copies++;
          paint([0, 0, width, height], '');
        }
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

/** A raster canvas as `rasterCanvas` returns it. */
export type RasterCanvas = ReturnType<typeof rasterCanvas>;
