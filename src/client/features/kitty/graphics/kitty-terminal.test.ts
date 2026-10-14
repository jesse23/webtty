import { describe, expect, test } from 'bun:test';
import {
  cellSize,
  deviceScale,
  type KittyTerminal,
  scrollbackLength,
  scrollOffset,
} from './kitty-terminal';

const bare: KittyTerminal = {
  write: () => {},
  buffer: { active: { cursorX: 0, cursorY: 0 } },
  viewportY: 0,
};

describe('kitty terminal readers', () => {
  test('before the renderer exists: 8x16 cells, no scroll offset, no scrollback', () => {
    expect(cellSize(bare)).toEqual({ width: 8, height: 16 });
    expect(scrollOffset(bare)).toBe(0);
    expect(scrollbackLength(bare)).toBe(0);
  });

  test('read the renderer and the wasm terminal once they exist', () => {
    const term: KittyTerminal = {
      ...bare,
      renderer: { getMetrics: () => ({ width: 9, height: 18 }), scrollOffset: 7 },
      wasmTerm: { isAlternateScreen: () => false, getScrollbackLength: () => 120 },
    };
    expect(cellSize(term)).toEqual({ width: 9, height: 18 });
    expect(scrollOffset(term)).toBe(7);
    expect(scrollbackLength(term)).toBe(120);
  });

  test('the alternate screen has no scrollback', () => {
    const term: KittyTerminal = {
      ...bare,
      wasmTerm: { isAlternateScreen: () => true, getScrollbackLength: () => 120 },
    };
    expect(scrollbackLength(term)).toBe(0);
  });

  test('metrics not measured yet fall back per field', () => {
    const term: KittyTerminal = {
      ...bare,
      renderer: { getMetrics: () => undefined, scrollOffset: 0 },
    };
    expect(cellSize(term)).toEqual({ width: 8, height: 16 });
  });

  test.each([
    [{ width: 10, height: 20 }, 2, { x: 2, y: 2 }],
    [{ width: 10, height: 20 }, 0, { x: 1, y: 1 }],
    [{ width: 9.6, height: 20.4 }, 1.25, { x: 12 / 9.6, y: 26 / 20.4 }],
  ])('deviceScale(%o, %d)', (cell, dpr, scale) => {
    expect(deviceScale(cell, dpr)).toEqual(scale);
  });
});
