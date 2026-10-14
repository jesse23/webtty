import { describe, expect, test } from 'bun:test';
import { KittyError } from './kitty-error';
import { assertCursorMovable, cursorAdvance, drawRect, placementAt } from './placement-geometry';

const ESC = '\x1b';
const cell = { width: 10, height: 20 };
const unit = { x: 1, y: 1 };

describe('assertCursorMovable', () => {
  test.each([
    [{}, { width: 2, height: 2 }, true],
    [{ C: '1' }, { width: 0, height: 0 }, true],
    [{}, { width: 0, height: 0 }, false],
    [{}, { width: 4, height: 0 }, false],
  ])('%o with %o: movable %p', (keys, size, movable) => {
    const run = () => assertCursorMovable(keys, size);
    if (movable) expect(run).not.toThrow();
    else expect(run).toThrow(KittyError);
  });
});

describe('placementAt', () => {
  test('takes the source rectangle, offsets and placement id from the keys', () => {
    const keys = { p: '4', x: '1', y: '2', w: '3', h: '5', X: '6', Y: '7' };
    expect(placementAt(keys, 9, { absRow: 12, col: 3 }, unit)).toEqual({
      imageId: 9,
      placementId: 4,
      absRow: 12,
      col: 3,
      srcX: 1,
      srcY: 2,
      srcW: 3,
      srcH: 5,
      offX: 6,
      offY: 7,
      scale: unit,
    });
  });

  test('records c and r only when given', () => {
    const p = placementAt({ c: '2', r: '3' }, 1, { absRow: 0, col: 0 }, unit);
    expect([p.cols, p.rows]).toEqual([2, 3]);
    const q = placementAt({}, 1, { absRow: 0, col: 0 }, unit);
    expect('cols' in q || 'rows' in q).toBe(false);
  });
});

describe('cursorAdvance', () => {
  const place = (keys: Record<string, string>, scale = unit) =>
    placementAt(keys, 1, { absRow: 0, col: 2 }, scale);

  test.each([
    ['one cell stays on the row', {}, { width: 10, height: 20 }, `${ESC}[4G`],
    ['2 x 2 cells', {}, { width: 20, height: 40 }, `\n${ESC}[5G`],
    ['the source rectangle wins', { w: '10', h: '20' }, { width: 50, height: 50 }, `${ESC}[4G`],
    ['x / y shrink the region', { x: '10', y: '20' }, { width: 30, height: 60 }, `\n${ESC}[5G`],
    ['c / r win', { c: '3', r: '2' }, { width: 1, height: 1 }, `\n${ESC}[6G`],
  ])('%s', (_name, keys, image, expected) => {
    expect(cursorAdvance(keys, place(keys), image, cell)).toBe(expected);
  });

  test('device pixels are converted with the placement scale', () => {
    const keys = {};
    expect(cursorAdvance(keys, place(keys, { x: 2, y: 2 }), { width: 20, height: 40 }, cell)).toBe(
      `${ESC}[4G`,
    );
  });

  test('C=1 leaves the cursor where it is', () => {
    const keys = { C: '1' };
    expect(cursorAdvance(keys, place(keys), { width: 20, height: 40 }, cell)).toBeNull();
  });
});

describe('drawRect', () => {
  test('a whole image at natural size, below the viewport top and the scroll offset', () => {
    const p = placementAt({}, 1, { absRow: 5, col: 2 }, { x: 2, y: 2 });
    expect(drawRect(p, { width: 40, height: 20 }, cell, 3, 4)).toEqual({
      sx: 0,
      sy: 0,
      sw: 40,
      sh: 20,
      x: 20,
      y: 2 * 20 + 4,
      dw: 20,
      dh: 10,
    });
  });

  test('a source rectangle with offsets, stretched over c x r cells', () => {
    const keys = { x: '2', y: '3', w: '8', h: '6', X: '4', Y: '2', c: '2', r: '1' };
    const p = placementAt(keys, 1, { absRow: 0, col: 1 }, { x: 2, y: 2 });
    expect(drawRect(p, { width: 100, height: 100 }, cell, 0, 0)).toEqual({
      sx: 2,
      sy: 3,
      sw: 8,
      sh: 6,
      x: 12,
      y: 1,
      dw: 20,
      dh: 20,
    });
  });

  test('only c given: the rows follow from the aspect ratio', () => {
    const p = placementAt({ c: '1' }, 1, { absRow: 0, col: 0 }, unit);
    expect(drawRect(p, { width: 10, height: 40 }, cell, 0, 0)).toMatchObject({ dw: 10, dh: 40 });
  });
});
