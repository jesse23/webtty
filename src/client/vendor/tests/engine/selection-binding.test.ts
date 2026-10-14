import { beforeAll, describe, expect, test } from 'bun:test';
import type { Ghostty, OfficialTerminal } from '../../ghostty-web/ghostty';
import { markedSession, THEME } from '../support/terminal-text';
import { loadGhostty } from '../support/wasm';

// Ghostty's selection rules (ADR 050, ADR 057, ADR 061): words, lines and command output
// picked from a cell, and the selected text, tested through OfficialTerminal.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('official engine: selection (ADR 050)', () => {
  test('selectWord uses Ghostty word boundaries and follows soft wraps', () => {
    const t = term(10, 4);
    t.write('a=b?c&d x\r\nab "cd" e\r\nx foo/bar/baz');
    const at = (col: number, row: number) => t.selectWord({ col, row });
    expect(at(2, 0)).toEqual({ start: { col: 0, row: 0 }, end: { col: 6, row: 0 } });
    expect(at(4, 1)).toEqual({ start: { col: 4, row: 1 }, end: { col: 5, row: 1 } });
    // "foo/bar/baz" wraps after column 9: the word runs on into the next row
    expect(at(3, 2)).toEqual({ start: { col: 2, row: 2 }, end: { col: 2, row: 3 } });
    expect(at(1, 3)).toEqual({ start: { col: 2, row: 2 }, end: { col: 2, row: 3 } });
    expect(at(9, 3)).toBeNull();
    t.free();
  });

  test('selectWord and selectLine take screen rows, scrollback included', () => {
    const t = term(10, 2);
    t.write('first one\r\nsecond\r\nthird');
    expect(t.getScrollbackLength()).toBe(1);
    expect(t.selectWord({ col: 1, row: 0 })).toEqual({
      start: { col: 0, row: 0 },
      end: { col: 4, row: 0 },
    });
    expect(t.selectLine({ col: 0, row: 2 })).toEqual({
      start: { col: 0, row: 2 },
      end: { col: 4, row: 2 },
    });
    expect(t.selectionText({ col: 0, row: 0 }, { col: 9, row: 2 })).toBe(
      'first one\nsecond\nthird',
    );
    t.free();
  });

  test('selectLine follows soft wraps and leaves out outer whitespace; a blank line is null', () => {
    const t = term(6, 4);
    t.write('  abcdefgh  \r\n\r\nx');
    expect(t.selectLine({ col: 1, row: 1 })).toEqual({
      start: { col: 2, row: 0 },
      end: { col: 3, row: 1 },
    });
    expect(t.selectLine({ col: 0, row: 2 })).toBeNull();
    t.free();
  });

  test('selectionText joins soft-wrapped rows, trims, takes either order and clamps', () => {
    const t = term(5, 3);
    t.write('abcdefg\r\nhi   ');
    expect(t.selectionText({ col: 0, row: 0 }, { col: 4, row: 2 })).toBe('abcdefg\nhi');
    expect(t.selectionText({ col: 4, row: 2 }, { col: 0, row: 0 })).toBe('abcdefg\nhi');
    expect(t.selectionText({ col: -3, row: -1 }, { col: 99, row: 99 })).toBe('abcdefg\nhi');
    expect(t.selectionText({ col: 3, row: 1 }, { col: 4, row: 1 })).toBe('');
    t.free();
  });

  test('selectionText reads the alternate screen while it is active', () => {
    const t = term(10, 2);
    t.write('a\r\nb\r\nc\x1b[?1049h\x1b[Halt');
    expect(t.getScrollbackLength()).toBe(0);
    expect(t.selectionText({ col: 0, row: 0 }, { col: 9, row: 0 })).toBe('alt');
    t.free();
  });
});

describe('official engine: command output (ADR 057)', () => {
  /** Prompts on rows 0, 7 and 14, and the current one on row 21 of 22. */
  const session = () => {
    const t = term(20, 5);
    t.write(markedSession());
    return t;
  };

  test('selectOutput selects the output of the command at a cell, null elsewhere', () => {
    const t = session();
    const one = { start: { col: 0, row: 1 }, end: { col: 4, row: 6 } };
    expect(t.selectOutput({ col: 0, row: 1 })).toEqual(one);
    expect(t.selectOutput({ col: 3, row: 4 })).toEqual(one);
    expect(t.selectionText(one.start, one.end)).toBe('one 0\none 1\none 2\none 3\none 4\none 5');
    expect(t.selectOutput({ col: 0, row: 10 })).toEqual({
      start: { col: 0, row: 8 },
      end: { col: 4, row: 13 },
    });
    // The prompt row, and a terminal with no marks
    expect(t.selectOutput({ col: 0, row: 21 })).toBeNull();
    t.free();
    const plain = term(20, 5);
    plain.write('a\r\nb');
    expect(plain.selectOutput({ col: 0, row: 0 })).toBeNull();
    plain.free();
  });
});
