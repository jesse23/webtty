import { describe, expect, test } from 'bun:test';
import { isNewMouseCell, mouseMotionButton } from './ghostty-web/input-handler';

describe('mouseMotionButton', () => {
  test('encodes hover (no button held) as 35', () => {
    expect(mouseMotionButton(0)).toBe(35);
  });

  test('encodes a left-button drag as 32', () => {
    expect(mouseMotionButton(1)).toBe(32);
  });

  test('encodes a middle-button drag as 33', () => {
    expect(mouseMotionButton(2)).toBe(33);
  });

  test('encodes a right-button drag as 34', () => {
    expect(mouseMotionButton(4)).toBe(34);
  });

  test('reports the lowest button when several are held', () => {
    expect(mouseMotionButton(1 | 4)).toBe(32);
    expect(mouseMotionButton(2 | 4)).toBe(33);
  });
});

describe('isNewMouseCell', () => {
  test('reports the first motion when nothing was reported yet', () => {
    expect(isNewMouseCell(null, { col: 8, row: 4 })).toBe(true);
  });

  test('drops motion within the last reported cell', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 8, row: 4 })).toBe(false);
  });

  test('reports motion into a new column', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 9, row: 4 })).toBe(true);
  });

  test('reports motion into a new row', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 8, row: 5 })).toBe(true);
  });
});
