import { beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, type GhosttyTerminal } from '../ghostty-web/ghostty';

// The official engine (ADR 042, ADR 047) replaying the same input two ways, cell
// for cell. A terminal that was scrolled, paged and cached while the input arrived
// must show what a fresh terminal fed the same input shows on its first read, so
// stale pages and lost dirty rows fail. Until ADR 047 these tests used the Coder
// engine as the reference.
//
// fixtures/*.bin are PTY captures at 120x40 (TERM=xterm-256color, LANG=en_US.UTF-8),
// recorded from an empty HOME in a scratch directory holding only a four-line
// sample.c: vim and nvim editing sample.c (`vim -u NONE`, `nvim --clean`), `man ls`
// in less, `ls -laG /usr/bin | head -80`, `top` showing one `sleep` process,
// `seq 5000`, an SGR/256-colour/truecolor test and a Unicode test.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OFFICIAL_WASM = path.join(HERE, '../ghostty-vt/ghostty-vt-small.wasm');
const FIXTURES = path.join(HERE, 'fixtures');
const COLS = 120;
const ROWS = 40;
const THEME = { fgColor: 0xd4d4d4, bgColor: 0x1e1e1e };

let vt: Ghostty;

beforeAll(async () => {
  vt = await Ghostty.load(OFFICIAL_WASM);
});

interface Cell {
  text: string;
  fg: number;
  bg: number;
  flags: number;
  width: number;
}

type Row = Cell[];

function toRow(line: ReturnType<GhosttyTerminal['getLine']>, grapheme: (x: number) => string): Row {
  return (line ?? []).map((c, x) => ({
    text: c.grapheme_len > 0 ? grapheme(x) : c.codepoint ? String.fromCodePoint(c.codepoint) : '',
    fg: (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b,
    bg: (c.bg_r << 16) | (c.bg_g << 8) | c.bg_b,
    flags: c.flags,
    width: c.width,
  }));
}

/** The active screen as the renderer reads it: one getViewport per frame. */
function screen(t: GhosttyTerminal): { grid: Row[]; cursor: { x: number; y: number } } {
  t.update();
  const { cols, rows } = t.getDimensions();
  const cells = t.getViewport();
  const grid: Row[] = [];
  for (let y = 0; y < rows; y++) {
    grid.push(toRow(cells.slice(y * cols, (y + 1) * cols), (x) => t.getGraphemeString(y, x)));
  }
  const { x, y } = t.getCursor();
  t.markClean();
  return { grid, cursor: { x, y } };
}

const activeRow = (t: GhosttyTerminal, y: number) =>
  toRow(t.getLine(y), (x) => t.getGraphemeString(y, x));
const scrollbackRow = (t: GhosttyTerminal, i: number) =>
  toRow(t.getScrollbackLine(i), (x) => t.getScrollbackGraphemeString(i, x));

/** The rows a renderer shows at viewportY = k, the way renderer.ts picks them. */
function shownRows(t: GhosttyTerminal, k: number): Row[] {
  t.setViewportOffset(k);
  const sb = t.getScrollbackLength();
  const rows: Row[] = [];
  for (let y = 0; y < t.rows; y++) {
    rows.push(y < k ? scrollbackRow(t, sb - k + y) : activeRow(t, y - k));
  }
  return rows;
}

const text = (row: Row) =>
  row
    .map((c) => (c.width === 0 ? '' : c.text || ' '))
    .join('')
    .trimEnd();

interface Difference {
  y: number;
  x: number;
  field: keyof Cell;
  expected: string | number;
  actual: string | number;
}

function diffRows(expected: Row[], actual: Row[]): Difference[] {
  const out: Difference[] = [];
  const rows = Math.max(expected.length, actual.length);
  for (let y = 0; y < rows; y++) {
    const a = expected[y] ?? [];
    const b = actual[y] ?? [];
    for (let x = 0; x < Math.max(a.length, b.length); x++) {
      for (const field of ['text', 'fg', 'bg', 'flags', 'width'] as const) {
        if (a[x]?.[field] !== b[x]?.[field]) {
          out.push({ y, x, field, expected: a[x]?.[field] ?? '-', actual: b[x]?.[field] ?? '-' });
        }
      }
    }
  }
  return out;
}

/**
 * A terminal under test that records its input, so a fresh terminal can be fed the
 * same writes and resizes as the reference.
 */
class Twin {
  readonly t: GhosttyTerminal;
  private readonly ops: ((t: GhosttyTerminal) => void)[] = [];

  constructor(
    private readonly cols: number,
    private readonly rows: number,
    private readonly config: object,
  ) {
    this.t = vt.createTerminal(cols, rows, config);
  }

  write(data: string | Uint8Array): void {
    this.ops.push((t) => t.write(data));
    this.t.write(data);
  }

  resize(cols: number, rows: number): void {
    this.ops.push((t) => t.resize(cols, rows));
    this.t.resize(cols, rows);
  }

  /** Runs `read` on a fresh terminal fed the same input, never scrolled or read before. */
  fresh<T>(read: (t: GhosttyTerminal) => T): T {
    const ref = vt.createTerminal(this.cols, this.rows, this.config);
    for (const op of this.ops) op(ref);
    try {
      return read(ref);
    } finally {
      ref.free();
    }
  }

  /** Differences between the rows shown at k and a fresh terminal's first read at k. */
  shownDiff(k: number): Difference[] {
    return diffRows(
      this.fresh((ref) => shownRows(ref, k)),
      shownRows(this.t, k),
    );
  }

  /** Differences between the active screen and a fresh terminal's. */
  screenDiff(): Difference[] {
    return diffRows(
      this.fresh((ref) => screen(ref).grid),
      screen(this.t).grid,
    );
  }

  free(): void {
    this.t.free();
  }
}

/**
 * Ghostty at 05dcf887 clusters the Hindi conjunct स्ते (U+0938 U+094D U+0924
 * U+0947) as one width-2 cell followed by a spacer, where the Coder wasm kept two
 * width-1 cells (ADR 041, ADR 042).
 */
function hasHindiConjunct(grid: Row[]): boolean {
  return grid.some((row) =>
    row.some((c, x) => c.text === 'स्ते' && c.width === 2 && row[x + 1]?.width === 0),
  );
}

const CAPTURES = ['ls', 'vim', 'nvim', 'less', 'top', 'sgr', 'uni', 'seq'];

describe('PTY captures at 120x40: 1-byte writes match 512-byte writes', () => {
  for (const name of CAPTURES) {
    test(name, () => {
      const data = new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.bin`)));
      const whole = vt.createTerminal(COLS, ROWS, THEME);
      const bytes = vt.createTerminal(COLS, ROWS, THEME);
      let checkpoints = 0;
      const compare = () => {
        const a = screen(whole);
        const b = screen(bytes);
        checkpoints++;
        expect(diffRows(a.grid, b.grid).slice(0, 10)).toEqual([]);
        expect(b.cursor).toEqual(a.cursor);
        return a.grid;
      };
      for (let i = 0; i < data.length; i += 512) {
        const piece = data.subarray(i, Math.min(i + 512, data.length));
        whole.write(piece);
        for (let j = 0; j < piece.length; j++) bytes.write(piece.subarray(j, j + 1));
        compare();
      }
      expect(checkpoints).toBeGreaterThan(0);
      expect(hasHindiConjunct(compare())).toBe(name === 'uni');
      whole.free();
      bytes.free();
    });
  }
});

describe('soft wraps', () => {
  test('isRowWrapped marks the rows that continue the row above', () => {
    const t = vt.createTerminal(10, 6, THEME);
    const wrapped = () => Array.from({ length: 6 }, (_, y) => t.isRowWrapped(y));
    t.write(`${'W'.repeat(25)}\r\nshort`);
    expect(wrapped()).toEqual([false, true, true, false, false, false]);
    // A line filling the row exactly, with the cursor parked at the margin, does not wrap yet.
    t.write(`\r\n${'X'.repeat(10)}`);
    expect(wrapped()).toEqual([false, true, true, false, false, false]);
    t.write('Y');
    expect(wrapped()).toEqual([false, true, true, false, false, true]);
    t.free();
  });
});

describe('scrolled views against a fresh terminal', () => {
  const lines = (from: number, to: number) => {
    let s = '';
    for (let i = from; i <= to; i++) {
      s += `\x1b[38;5;${i % 256}mline ${i}\x1b[0m ${'x'.repeat(i % 50)}\r\n`;
    }
    return s;
  };
  // No line limit, so every written row is kept.
  const config = { ...THEME, scrollbackLines: 0 };

  test('scrollback pages match the same rows decoded on a screen tall enough to hold them', () => {
    const t = vt.createTerminal(80, 24, config);
    const tall = vt.createTerminal(80, 400, config);
    t.write(lines(1, 300));
    tall.write(lines(1, 300));
    const sb = t.getScrollbackLength();
    expect(sb).toBe(301 - 24);
    expect(tall.getScrollbackLength()).toBe(0);
    t.setViewportOffset(40);
    for (let i = 0; i < sb; i++) {
      expect(diffRows([activeRow(tall, i)], [scrollbackRow(t, i)])).toEqual([]);
    }
    for (let y = 0; y < 24; y++) {
      expect(diffRows([activeRow(tall, sb + y)], [activeRow(t, y)])).toEqual([]);
    }
    t.free();
    tall.free();
  });

  test('getLine, getScrollbackLine and the shown rows match at several offsets', () => {
    const tw = new Twin(80, 24, config);
    tw.write(lines(1, 300));
    const sb = tw.t.getScrollbackLength();
    for (const k of [0, 1, 5, 23, 24, 25, 100, sb]) {
      expect(tw.shownDiff(k)).toEqual([]);
      for (const y of [0, 10, 23]) {
        expect(diffRows([tw.fresh((ref) => activeRow(ref, y))], [activeRow(tw.t, y)])).toEqual([]);
      }
    }
    tw.t.setViewportOffset(40);
    const expected = tw.fresh((ref) => Array.from({ length: sb }, (_, i) => scrollbackRow(ref, i)));
    for (let i = 0; i < sb; i += 7) {
      expect(diffRows([expected[i]], [scrollbackRow(tw.t, i)])).toEqual([]);
    }
    expect(tw.screenDiff()).toEqual([]);
    tw.free();
  });

  test('a write while scrolled snaps to the bottom, and a stale offset moves back', () => {
    const tw = new Twin(80, 24, config);
    tw.write(lines(1, 200));
    shownRows(tw.t, 30);
    tw.write(lines(201, 210));
    expect(tw.t.isRowDirty(0)).toBe(true);
    expect(tw.screenDiff()).toEqual([]);
    // The awaitingEcho render passes the stale viewportY.
    expect(tw.shownDiff(30)).toEqual([]);
    expect(tw.shownDiff(0)).toEqual([]);
    tw.free();
  });

  test('a resize while scrolled reflows the same rows', () => {
    const tw = new Twin(80, 24, config);
    tw.write(lines(1, 200));
    shownRows(tw.t, 30);
    // Shrinking rewraps the long lines.
    tw.resize(60, 20);
    expect(tw.t.getScrollbackLength()).toBe(tw.fresh((ref) => ref.getScrollbackLength()));
    expect(tw.shownDiff(30)).toEqual([]);
    expect(tw.screenDiff()).toEqual([]);
    // Growing unwraps them again, back to the text that was written.
    shownRows(tw.t, 30);
    tw.resize(100, 30);
    const sb = tw.t.getScrollbackLength();
    expect(sb).toBe(tw.fresh((ref) => ref.getScrollbackLength()));
    const written = (i: number) => `line ${i} ${'x'.repeat(i % 50)}`.trimEnd();
    const expected = Array.from({ length: 30 }, (_, y) => written(sb - 30 + y + 1));
    expect(shownRows(tw.t, 30).map(text)).toEqual(expected);
    for (let i = 0; i < sb; i++) expect(text(scrollbackRow(tw.t, i))).toBe(written(i + 1));
    expect(tw.shownDiff(30)).toEqual([]);
    expect(tw.screenDiff()).toEqual([]);
    tw.free();
  });

  test('a page read between a write and the next render loses no dirty rows', () => {
    const tw = new Twin(80, 24, config);
    tw.write(lines(1, 100));
    screen(tw.t);
    tw.write('\x1b[5;3HCHANGED');
    // A selection copy or buffer read above the viewport before the frame.
    expect(diffRows([tw.fresh((ref) => scrollbackRow(ref, 3))], [scrollbackRow(tw.t, 3)])).toEqual(
      [],
    );
    expect(tw.t.isRowDirty(4)).toBe(true);
    expect(tw.t.isRowDirty(10)).toBe(false);
    expect(text(activeRow(tw.t, 4))).toContain('CHANGED');
    expect(tw.screenDiff()).toEqual([]);
    tw.free();
  });

  test('stepping the offset through the screen keeps pages across moves, not writes', () => {
    const tw = new Twin(80, 24, config);
    tw.write(lines(1, 300));
    const sb = tw.t.getScrollbackLength();
    const walk = (ks: number[]) => {
      for (const k of ks) {
        expect(tw.shownDiff(k)).toEqual([]);
        // The renderer's active rows come from one getViewport per frame.
        expect(tw.screenDiff()).toEqual([]);
      }
    };
    const steps = [0, 1, 2, 12, 22, 23, 24, 25, 47, 48, 49, 100, sb, 30, 23, 1, 0];
    walk(steps);
    // An in-place write below the view, then the same walk: no page from before it.
    tw.t.setViewportOffset(10);
    tw.write('\x1b[24;1HAFTER\x1b[1;1HTOP');
    walk(steps);
    tw.free();
  });

  // Graphemes in scrollback and on screen: VS16 emoji, a skin-tone modifier and a
  // combining mark, so the scrolled rows' grapheme lookups are compared too.
  const graphemeLines = (from: number, to: number) => {
    let s = '';
    for (let i = from; i <= to; i++) {
      s +=
        i % 3 === 0
          ? `\x1b[38;2;200;120;80m⏺️\x1b[0m ${i} café 👍🏽 ✔︎\r\n`
          : `\x1b[48;5;${i % 256}mrow ${i}\x1b[0m ${'─'.repeat(i % 40)}\r\n`;
    }
    return s;
  };

  test('a scroll walk past the screen and back matches rows, graphemes and cursor', () => {
    const tw = new Twin(80, 24, config);
    tw.write(`${graphemeLines(1, 200)}\x1b[3;7H`);
    const sb = tw.t.getScrollbackLength();
    expect(sb).toBe(201 - 24);
    // The graphemes as written, so the reference is not just the same decoder.
    expect(text(scrollbackRow(tw.t, 2))).toBe('⏺️ 3 café 👍🏽 ✔︎');
    const ks = [
      ...Array.from({ length: 60 }, (_, k) => k),
      sb - 1,
      sb,
      sb + 5,
      ...Array.from({ length: 60 }, (_, k) => 59 - k),
    ];
    for (const k of ks) {
      expect(tw.shownDiff(k)).toEqual([]);
      expect(tw.t.getCursor()).toMatchObject({ x: 6, y: 2 });
      expect(tw.screenDiff()).toEqual([]);
    }
    tw.free();
  });

  test('output while scrolled shows the new rows at the bottom and in later scrolls', () => {
    const tw = new Twin(80, 24, config);
    tw.write(graphemeLines(1, 120));
    for (const k of [5, 30]) shownRows(tw.t, k);
    tw.write(graphemeLines(121, 130));
    expect(tw.t.needsFullRedraw()).toBe(true);
    expect(tw.t.getScrollbackLength()).toBe(131 - 24);
    for (const k of [0, 3, 24, 30, 0]) expect(tw.shownDiff(k)).toEqual([]);
    tw.free();
  });

  test('a resize while scrolled keeps the walk matching', () => {
    const tw = new Twin(80, 24, config);
    tw.write(graphemeLines(1, 150));
    for (const k of [10, 40]) shownRows(tw.t, k);
    tw.resize(70, 20);
    expect(tw.t.getScrollbackLength()).toBe(tw.fresh((ref) => ref.getScrollbackLength()));
    for (const k of [40, 39, 20, 19, 1, 0, 25]) {
      expect(tw.shownDiff(k)).toEqual([]);
      expect(tw.screenDiff()).toEqual([]);
    }
    tw.free();
  });

  test('a page read after an in-place write does not return stale cells', () => {
    const tw = new Twin(80, 24, config);
    tw.write(lines(1, 100));
    // Scrolled by 10: the bottom 10 active rows are below the view, read as a page.
    shownRows(tw.t, 10);
    expect(text(activeRow(tw.t, 23))).toBe('');
    tw.write('\x1b[24;1HIN PLACE');
    expect(tw.shownDiff(10)).toEqual([]);
    expect(text(activeRow(tw.t, 23))).toStartWith('IN PLACE');
    expect(diffRows([tw.fresh((ref) => activeRow(ref, 23))], [activeRow(tw.t, 23)])).toEqual([]);
    tw.free();
  });
});

describe('coder/ghostty-web#180 stress payload', () => {
  // Port of buildStressPayload() from coder/ghostty-web lib/viewport-corruption.test.ts
  // (PR #180; MIT, Copyright (c) 2025 Coder, see ghostty-web/LICENSE).
  const ESC = '\x1b';
  function buildStressPayload(): string {
    const lines: string[] = [];
    let n = 0;
    const marked = (content: string) => {
      const marker = `R00L${n.toString().padStart(3, '0')}`;
      lines.push(`${ESC}[38;5;${(n * 17) % 256}m${marker}${ESC}[0m ${content}`);
      n++;
    };
    const blank = () => {
      lines.push('');
      n++;
    };
    marked(`${ESC}[1m${'═'.repeat(72)}${ESC}[0m`);
    marked(`${ESC}[1mTerminal rendering scroll-growth regression${ESC}[0m`);
    blank();
    marked(`${ESC}[1m256-color palette${ESC}[0m`);
    for (let row = 0; row < 8; row++) {
      let c = '';
      for (let i = 0; i < 32; i++) c += `${ESC}[48;5;${row * 32 + i}m  ${ESC}[0m`;
      marked(c);
    }
    blank();
    marked(`${ESC}[1mTruecolor gradients${ESC}[0m`);
    for (let row = 0; row < 8; row++) {
      let c = '';
      for (let i = 0; i < 80; i++) {
        const r = Math.floor(Math.sin(i * 0.08 + row) * 127 + 128);
        const g = Math.floor(Math.sin(i * 0.08 + row + 2) * 127 + 128);
        const b = Math.floor(Math.sin(i * 0.08 + row + 4) * 127 + 128);
        c += `${ESC}[48;2;${r};${g};${b}m ${ESC}[0m`;
      }
      marked(c);
    }
    blank();
    marked(`${ESC}[1mCombined styles${ESC}[0m`);
    marked(
      `${ESC}[1mBold${ESC}[0m  ${ESC}[3mItalic${ESC}[0m  ${ESC}[4mUnderline${ESC}[0m  ` +
        `${ESC}[7mReverse${ESC}[0m  ${ESC}[9mStrike${ESC}[0m`,
    );
    marked(
      `${ESC}[1;31mBold Red${ESC}[0m  ${ESC}[3;32mItalic Green${ESC}[0m  ` +
        `${ESC}[4;34mUnderline Blue${ESC}[0m  ${ESC}[38;5;201mPalette Pink${ESC}[0m`,
    );
    blank();
    marked(`${ESC}[1mSoft-wrap metadata seed${ESC}[0m`);
    marked('wrap '.repeat(48));
    blank();
    marked(`${ESC}[1mUnicode box drawing${ESC}[0m`);
    for (const line of [
      '┌──────────┬──────────┬──────────┐',
      '│  Cell A  │  Cell B  │  Cell C  │',
      '├──────────┼──────────┼──────────┤',
      '│  Cell D  │  Cell E  │  Cell F  │',
      '└──────────┴──────────┴──────────┘',
    ]) {
      marked(line);
    }
    blank();
    for (let section = 0; section < 8; section++) {
      marked(`${ESC}[1mColor grid ${String.fromCharCode(65 + section)}${ESC}[0m`);
      for (let row = 0; row < 8; row++) {
        let c = '';
        for (let i = 0; i < 70; i++) {
          const idx = (section * 64 + row * 8 + i) % 256;
          c +=
            (i + row) % 3 === 0
              ? `${ESC}[38;2;${(idx * 7) % 256};${(idx * 13) % 256};${(idx * 23) % 256}m*${ESC}[0m`
              : `${ESC}[38;5;${idx}m*${ESC}[0m`;
        }
        marked(c);
      }
      blank();
    }
    marked(`${ESC}[1m${'═'.repeat(72)}${ESC}[0m`);
    marked(`${ESC}[32m✓${ESC}[0m Test complete`);
    blank();
    return `${lines.join('\r\n')}\r\n`;
  }

  test('0 stale rows over 300 repetitions', () => {
    const cols = 160;
    const rows = 39;
    const t = vt.createTerminal(cols, rows, { ...THEME, scrollbackLines: 0 });
    const payload = new TextEncoder().encode(buildStressPayload());
    const failures: string[] = [];
    let baseline: string[] | null = null;
    for (let rep = 0; rep < 300; rep++) {
      t.write(payload);
      const { grid } = screen(t);
      const shown = grid.map(text);
      shown.forEach((row, y) => {
        const markers = new Set(row.match(/R\d{2}L\d{3}/g) ?? []);
        if (markers.size > 1) failures.push(`rep ${rep} row ${y}: merged ${[...markers]}`);
        // isRowWrapped(y + 1): the next row continues this one, so this one wraps.
        if (row.length === 0 && y + 1 < rows && t.isRowWrapped(y + 1))
          failures.push(`rep ${rep} row ${y}: blank, wrapped`);
      });
      baseline ??= shown;
      const changed = shown.findIndex((row, y) => row !== baseline?.[y]);
      if (changed !== -1) failures.push(`rep ${rep} row ${changed} differs from rep 0`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
    t.free();
  });
});
