import { describe, expect, test } from 'bun:test';
import { FitAddon, fitDimensions } from './ghostty-web/addons/fit';
import type { ITerminalCore } from './ghostty-web/interfaces';

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const pad = (p: number) => ({ top: p, right: p, bottom: p, left: p });

describe('fitDimensions', () => {
  test('uses the whole container width, with no scrollbar reserve', () => {
    // 800px / 10px = exactly 80 columns; a 15px reserve would give 78.
    expect(fitDimensions(800, 400, NONE, 10, 20)).toEqual({ cols: 80, rows: 20 });
  });

  test('floors to whole cells', () => {
    expect(fitDimensions(809, 419, NONE, 10, 20)).toEqual({ cols: 80, rows: 20 });
    expect(fitDimensions(799, 399, NONE, 10, 20)).toEqual({ cols: 79, rows: 19 });
  });

  test('handles fractional cell sizes', () => {
    expect(fitDimensions(1000, 500, NONE, 8.4, 17)).toEqual({ cols: 119, rows: 29 });
  });

  test('subtracts the padding on each side', () => {
    // 800px - 2 x 10px = 780px -> 78 cols; 400px - 2 x 10px = 380px -> 19 rows.
    expect(fitDimensions(800, 400, pad(10), 10, 20)).toEqual({ cols: 78, rows: 19 });
    // Sides are independent: 800 - 5 - 15 = 780 -> 78; 400 - 0 - 40 = 360 -> 18.
    expect(fitDimensions(800, 400, { top: 0, right: 15, bottom: 40, left: 5 }, 10, 20)).toEqual({
      cols: 78,
      rows: 18,
    });
  });

  test('never goes below the minimum grid', () => {
    expect(fitDimensions(5, 5, NONE, 10, 20)).toEqual({ cols: 2, rows: 1 });
    expect(fitDimensions(100, 100, pad(60), 10, 20)).toEqual({ cols: 2, rows: 1 });
  });
});

// webtty sizes the grid from proposeDimensions alone (ADR 033).
describe('FitAddon.proposeDimensions', () => {
  test("fits the element's client size, less its padding, in renderer cells", () => {
    const win = globalThis.window;
    globalThis.window = {
      getComputedStyle: () => ({ getPropertyValue: () => '10px' }),
    } as unknown as Window & typeof globalThis;
    try {
      const addon = new FitAddon();
      expect(addon.proposeDimensions()).toBeUndefined();
      addon.activate({
        element: { clientWidth: 820, clientHeight: 420 },
        renderer: { getMetrics: () => ({ width: 10, height: 20 }) },
      } as unknown as ITerminalCore);
      expect(addon.proposeDimensions()).toEqual({ cols: 80, rows: 20 });
      addon.dispose();
      expect(addon.proposeDimensions()).toBeUndefined();
    } finally {
      globalThis.window = win;
    }
  });
});
