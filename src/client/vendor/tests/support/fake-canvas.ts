// A 2D canvas context that draws nothing (test fake, ADR 064), for vendor tests that open
// a whole Terminal and only care about what it wires up, not what it paints.

/** The glyph box every `measureText` reports: an 8 px wide cell, 10 px ascent, 3 px descent. */
export const FAKE_GLYPH = { width: 8, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 };

/**
 * A `CanvasRenderingContext2D` stand-in: `measureText` reports `FAKE_GLYPH`, every other
 * method is a no-op and every property accepts and keeps what is written to it, so the
 * renderer can measure its font and draw frames on it.
 */
export function fakeContext2d(): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = {
    measureText: () => ({ ...FAKE_GLYPH }),
  };
  const context = new Proxy(state, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  return context as unknown as CanvasRenderingContext2D;
}
