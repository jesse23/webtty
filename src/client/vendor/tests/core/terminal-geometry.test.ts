import { describe, expect, test } from 'bun:test';
import {
  cursorCellOffset,
  deviceCellPixels,
  linkViewportRange,
  mouseCursorFor,
  mouseSurface,
  pointerCell,
  setStylePx,
  viewportRowToBufferRow,
} from '../../ghostty-web/core/terminal-geometry';
import type { ILink } from '../../ghostty-web/link-types';

// Terminal's pixel and row maths: one mapping for the mouse, the links and the textarea.

describe('mouseCursorFor', () => {
  const link: ILink = {
    text: 'https://example.com',
    range: { start: { x: 0, y: 0 }, end: { x: 18, y: 0 } },
    activate: () => {},
  };

  test('uses the default arrow when no link is hovered', () => {
    expect(mouseCursorFor(undefined)).toBe('default');
  });

  test('uses the pointer over a link', () => {
    expect(mouseCursorFor(link)).toBe('pointer');
  });
});

describe('pointerCell', () => {
  const cell = { charWidth: 8, charHeight: 16, scrollOffset: 0 };

  test.each([
    [0, 0, { x: 0, y: 0 }],
    [7.9, 15.9, { x: 0, y: 0 }],
    [8, 16, { x: 1, y: 1 }],
    [41, 17, { x: 5, y: 1 }],
  ])('(%p, %p) on a canvas at the origin is cell %o', (clientX, clientY, expected) => {
    expect(pointerCell(clientX, clientY, { left: 0, top: 0 }, cell)).toEqual(expected);
  });

  test('measures from the canvas corner', () => {
    expect(pointerCell(110, 66, { left: 100, top: 50 }, cell)).toEqual({ x: 1, y: 1 });
  });

  test('rows start the scroll offset below the canvas top (ADR 043)', () => {
    expect(pointerCell(0, 20, { left: 0, top: 0 }, { ...cell, scrollOffset: 6 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  test('a position left of or above the grid is a negative cell', () => {
    expect(pointerCell(-1, -1, { left: 0, top: 0 }, cell)).toEqual({ x: -1, y: -1 });
  });
});

describe('viewportRowToBufferRow', () => {
  test.each([
    // At the bottom: the screen follows the scrollback
    [0, 100, 0, 100],
    [5, 100, 0, 105],
    // Scrolled back: rows above the view's depth are scrollback, below it the screen
    [0, 100, 10, 90],
    [9, 100, 10, 99],
    [10, 100, 10, 100],
    [12, 100, 10, 102],
    // A smooth-scroll offset is floored, as the renderer floors it
    [3, 100, 10.7, 93],
    // A negative view never shows rows past the screen
    [3, 100, -2, 103],
  ])(
    'row %p with %p of scrollback, %p back, is buffer row %p',
    (row, scrollback, view, expected) => {
      expect(viewportRowToBufferRow(row, scrollback, view)).toBe(expected);
    },
  );
});

describe('linkViewportRange', () => {
  const range = (startY: number, endY: number) => ({
    start: { x: 3, y: startY },
    end: { x: 8, y: endY },
  });

  test('maps a link on screen to its viewport rows', () => {
    expect(linkViewportRange(range(101, 101), 100, 0, 24)).toEqual({
      startX: 3,
      startY: 1,
      endX: 8,
      endY: 1,
    });
  });

  test('follows the view into the scrollback, floored', () => {
    expect(linkViewportRange(range(95, 96), 100, 10.5, 24)).toEqual({
      startX: 3,
      startY: 5,
      endX: 8,
      endY: 6,
    });
  });

  test('clamps a link that runs off the top or the bottom of the view', () => {
    expect(linkViewportRange(range(99, 101), 100, 0, 24)).toMatchObject({ startY: 0, endY: 1 });
    expect(linkViewportRange(range(122, 130), 100, 0, 24)).toMatchObject({
      startY: 22,
      endY: 23,
    });
  });

  test('is null when none of the link is in view', () => {
    expect(linkViewportRange(range(90, 99), 100, 0, 24)).toBeNull();
    expect(linkViewportRange(range(124, 125), 100, 0, 24)).toBeNull();
  });
});

describe('cursorCellOffset', () => {
  const grid = { cols: 80, rows: 24 };
  const cell = { width: 9, height: 18 };
  const canvas = { left: 0, top: 0 };

  test('puts the spot at the cursor cell', () => {
    expect(cursorCellOffset({ x: 10, y: 5 }, 0, grid, cell, canvas)).toEqual({
      left: 90,
      top: 90,
    });
  });

  test('offsets by the canvas position inside the padding', () => {
    expect(cursorCellOffset({ x: 0, y: 0 }, 0, grid, cell, { left: 12, top: 8 })).toEqual({
      left: 12,
      top: 8,
    });
  });

  test('moves down with the scrollback offset', () => {
    expect(cursorCellOffset({ x: 0, y: 5 }, 3, grid, cell, canvas).top).toBe(8 * 18);
  });

  test('stays on the last row once the cursor scrolls out of view', () => {
    expect(cursorCellOffset({ x: 0, y: 20 }, 100, grid, cell, canvas).top).toBe(23 * 18);
  });

  test('clamps a pending-wrap cursor to the last column', () => {
    expect(cursorCellOffset({ x: 80, y: 0 }, 0, grid, cell, canvas).left).toBe(79 * 9);
  });
});

describe('deviceCellPixels', () => {
  test('is the CSS cell at the device pixel ratio, in whole pixels', () => {
    expect(deviceCellPixels(9, 2)).toBe(18);
    expect(deviceCellPixels(8.4, 1.25)).toBe(11);
    expect(deviceCellPixels(19.2, 1.5)).toBe(29);
  });

  test('never reports less than one pixel', () => {
    expect(deviceCellPixels(0, 2)).toBe(1);
    expect(deviceCellPixels(0.2, 1)).toBe(1);
  });
});

describe('mouseSurface', () => {
  // A 9.6 x 19.2 px CSS cell at DPR 1.25 is 12 x 24 device pixels.
  const grid = { left: 110, top: 57, cols: 100, rows: 30, cellWidth: 9.6, cellHeight: 19.2 };
  const box = { left: 100, top: 50, right: 110 + 960 + 7, bottom: 57 + 576 + 3 };
  const cellPx = { width: 12, height: 24 };
  const surface = (x: number, y: number) => mouseSurface(x, y, grid, box, cellPx);

  test('is the container in device-pixel cells, the padding around the grid', () => {
    expect(surface(0, 0).geometry).toEqual({
      screenWidth: 13 + 1200 + 9,
      screenHeight: 9 + 720 + 4,
      cellWidth: 12,
      cellHeight: 24,
      paddingTop: 9,
      paddingRight: 9,
      paddingBottom: 4,
      paddingLeft: 13,
    });
  });

  test('puts cell boundaries exactly where the CSS grid has them, at any column', () => {
    // Column 99 (0-based) starts at 110 + 99 * 9.6 = 1060.4 CSS px
    const cell = (x: number) => Math.floor((surface(x, 60).x - 13) / 12);
    expect(cell(1060.3)).toBe(98);
    expect(cell(1060.5)).toBe(99);
    expect(cell(110)).toBe(0);
    const row = (y: number) => Math.floor((surface(120, y).y - 9) / 24);
    expect(row(57 + 29 * 19.2 - 0.1)).toBe(28);
    expect(row(57 + 29 * 19.2 + 0.1)).toBe(29);
  });

  test('positions in the padding fall before or after the grid', () => {
    expect(surface(101, 51).x).toBeLessThan(13);
    expect(surface(101, 51).y).toBeLessThan(9);
    expect(surface(1075, 60).x).toBeGreaterThan(13 + 1200);
  });

  test('a grid past the container edge has no negative padding', () => {
    const tight = mouseSurface(
      0,
      0,
      grid,
      { left: 120, top: 60, right: 1000, bottom: 600 },
      cellPx,
    );
    expect(tight.geometry).toMatchObject({
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
    });
  });
});

describe('setStylePx', () => {
  /** An element whose style records each write. */
  function element() {
    const writes: string[] = [];
    const style = new Proxy(
      { left: '', top: '', width: '', height: '' },
      {
        set: (target, prop, value) => {
          writes.push(`${String(prop)}=${value}`);
          return Reflect.set(target, prop, value);
        },
      },
    );
    return { el: { style }, writes };
  }

  test('writes a changed value in pixels, and an unchanged one not at all', () => {
    const { el, writes } = element();
    setStylePx(el, 'left', 12);
    setStylePx(el, 'left', 12);
    setStylePx(el, 'height', 18.5);
    expect(writes).toEqual(['left=12px', 'height=18.5px']);
  });
});
