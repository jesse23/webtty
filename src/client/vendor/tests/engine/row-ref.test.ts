import { describe, expect, test } from 'bun:test';
import {
  blankCell,
  blankCells,
  copyRow,
  graphemeOf,
  type RowRef,
  setRgb,
} from '../../ghostty-web/engine/row-ref';

// The decoded row helpers (ADR 061): blank cells, colour writes, row copies and the text
// of one cell.

function row(codepoints: number[], base = 0, graphemes: RowRef['graphemes'] = null): RowRef {
  const cells = blankCells(base + codepoints.length);
  codepoints.forEach((cp, i) => {
    cells[base + i].codepoint = cp;
  });
  return { cells, base, graphemes };
}

describe('row-ref', () => {
  test('a blank cell is an empty, narrow, unstyled cell; each call is a new object', () => {
    expect(blankCell()).toEqual({
      codepoint: 0,
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
    });
    expect(blankCell()).not.toBe(blankCell());
    const cells = blankCells(3);
    expect(cells.length).toBe(3);
    expect(cells[0]).not.toBe(cells[1]);
    expect(blankCells(0)).toEqual([]);
  });

  test('setRgb splits 0xRRGGBB colours into the channels', () => {
    const cell = blankCell();
    setRgb(cell, 0x123456, 0xabcdef);
    expect([cell.fg_r, cell.fg_g, cell.fg_b]).toEqual([0x12, 0x34, 0x56]);
    expect([cell.bg_r, cell.bg_g, cell.bg_b]).toEqual([0xab, 0xcd, 0xef]);
  });

  test('copyRow copies the cols cells from the base, each a new object', () => {
    const ref = row([0x61, 0x62, 0x63], 2);
    const copy = copyRow(ref, 2);
    expect(copy.map((c) => c.codepoint)).toEqual([0x61, 0x62]);
    expect(copy[0]).not.toBe(ref.cells[2]);
    copy[0].codepoint = 0x7a;
    expect(ref.cells[2].codepoint).toBe(0x61);
  });

  test.each([
    ['a grapheme string', 0, 'é'],
    ['the codepoint', 1, 'x'],
    ['a space for an empty cell', 2, ' '],
  ])('graphemeOf reads %s', (_what, col, expected) => {
    const ref = row([0x65, 0x78, 0], 1, new Map([[0, 'é']]));
    expect(graphemeOf(ref, col)).toBe(expected);
  });

  test('graphemeOf reads the codepoint when the row has no graphemes', () => {
    expect(graphemeOf(row([0x1f600]), 0)).toBe('😀');
  });
});
