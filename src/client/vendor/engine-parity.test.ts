import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty, type GhosttyTerminal } from './ghostty-web/ghostty';

// Both engines (ADR 042) on the same input, cell for cell.
//
// fixtures/*.bin are PTY captures at 120x40 (TERM=xterm-256color, LANG=en_US.UTF-8),
// recorded from an empty HOME in a scratch directory holding only a four-line
// sample.c: vim and nvim editing sample.c (`vim -u NONE`, `nvim --clean`), `man ls`
// in less, `ls -laG /usr/bin | head -80`, `top` showing one `sleep` process,
// `seq 5000`, an SGR/256-colour/truecolor test and a Unicode test.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODER_WASM = path.join(HERE, 'ghostty-web/ghostty-vt.wasm');
const OFFICIAL_WASM = path.join(HERE, 'ghostty-vt/ghostty-vt-small.wasm');
const FIXTURES = path.join(HERE, 'fixtures');
const COLS = 120;
const ROWS = 40;
const THEME = { scrollbackLimit: 10000, fgColor: 0xd4d4d4, bgColor: 0x1e1e1e };

interface Cell {
  text: string;
  fg: number;
  bg: number;
  flags: number;
  width: number;
}

type Row = Cell[];

interface Engines {
  coder: GhosttyTerminal;
  official: GhosttyTerminal;
}

/**
 * A fresh instance of each engine. The Coder wasm can crash on a terminal created
 * after another one that held multi-codepoint graphemes was freed (ADR 041), so
 * every Coder terminal gets its own instance and is never freed.
 */
async function engines(cols = COLS, rows = ROWS, config: object = THEME): Promise<Engines> {
  const coder = (await Ghostty.load(CODER_WASM)).createTerminal(cols, rows, config);
  const official = (await Ghostty.load(OFFICIAL_WASM, 'official')).createTerminal(
    cols,
    rows,
    config,
  );
  return { coder, official };
}

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
  t.setViewportOffset?.(k);
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
  coder: string | number;
  official: string | number;
}

function diffRows(coder: Row[], official: Row[]): Difference[] {
  const out: Difference[] = [];
  const rows = Math.max(coder.length, official.length);
  for (let y = 0; y < rows; y++) {
    const a = coder[y] ?? [];
    const b = official[y] ?? [];
    for (let x = 0; x < Math.max(a.length, b.length); x++) {
      for (const field of ['text', 'fg', 'bg', 'flags', 'width'] as const) {
        if (a[x]?.[field] !== b[x]?.[field]) {
          out.push({ y, x, field, coder: a[x]?.[field] ?? '-', official: b[x]?.[field] ?? '-' });
        }
      }
    }
  }
  return out;
}

/**
 * The one listed difference (ADR 041, ADR 042): Ghostty at 05dcf887 clusters the
 * Hindi conjunct स्ते (U+0938 U+094D U+0924 U+0947) as one width-2 cell, where the
 * Coder wasm keeps two width-1 cells, स् and ते. Both take two columns, so nothing
 * after it moves.
 */
function isHindiConjunct(d: Difference, coder: Row[], official: Row[]): boolean {
  const a = coder[d.y];
  const b = official[d.y];
  const lead = (x: number) =>
    a[x]?.text === 'स्' && a[x]?.width === 1 && b[x]?.text === 'स्ते' && b[x]?.width === 2;
  const tail = (x: number) =>
    a[x]?.text === 'ते' && a[x]?.width === 1 && b[x]?.text === '' && b[x]?.width === 0;
  return (d.field === 'text' || d.field === 'width') && (lead(d.x) || (lead(d.x - 1) && tail(d.x)));
}

interface ParityResult {
  checkpoints: number;
  cells: number;
  unexpected: Difference[];
  known: number;
  cursorDiffs: number;
}

/** Feeds a capture to both engines in `chunk`-byte writes, comparing every 512 bytes and at the end. */
async function replay(name: string, chunk: number): Promise<ParityResult> {
  const data = new Uint8Array(fs.readFileSync(path.join(FIXTURES, `${name}.bin`)));
  const { coder, official } = await engines();
  const result: ParityResult = {
    checkpoints: 0,
    cells: 0,
    unexpected: [],
    known: 0,
    cursorDiffs: 0,
  };
  const compare = () => {
    const a = screen(coder);
    const b = screen(official);
    result.checkpoints++;
    result.cells += COLS * ROWS;
    for (const d of diffRows(a.grid, b.grid)) {
      if (isHindiConjunct(d, a.grid, b.grid)) result.known++;
      else if (result.unexpected.length < 10) result.unexpected.push(d);
    }
    if (a.cursor.x !== b.cursor.x || a.cursor.y !== b.cursor.y) result.cursorDiffs++;
  };
  for (let i = 0; i < data.length; i += chunk) {
    const piece = data.subarray(i, Math.min(i + chunk, data.length));
    coder.write(piece);
    official.write(piece);
    if ((i + chunk) % 512 === 0) compare();
  }
  compare();
  official.free();
  return result;
}

const CAPTURES = ['ls', 'vim', 'nvim', 'less', 'top', 'sgr', 'uni', 'seq'];

describe('engine parity on PTY captures at 120x40', () => {
  for (const name of CAPTURES) {
    for (const chunk of [512, 1]) {
      test(`${name}, ${chunk}-byte writes`, async () => {
        const result = await replay(name, chunk);
        expect(result.checkpoints).toBeGreaterThan(0);
        expect(result.unexpected).toEqual([]);
        expect(result.cursorDiffs).toBe(0);
        // The Hindi conjunct is the one listed difference, and only uni.bin has it.
        if (name === 'uni') expect(result.known).toBeGreaterThan(0);
        else expect(result.known).toBe(0);
      });
    }
  }
});

describe('engine parity on soft wraps', () => {
  test('isRowWrapped marks the rows that continue the row above', async () => {
    const { coder, official } = await engines(10, 6);
    const write = (data: string) => {
      coder.write(data);
      official.write(data);
    };
    const wrapped = (t: GhosttyTerminal) => Array.from({ length: 6 }, (_, y) => t.isRowWrapped(y));
    write(`${'W'.repeat(25)}\r\nshort`);
    expect(wrapped(coder)).toEqual([false, true, true, false, false, false]);
    expect(wrapped(official)).toEqual(wrapped(coder));
    // A line filling the row exactly, with the cursor parked at the margin, does not wrap yet.
    write(`\r\n${'X'.repeat(10)}`);
    expect(wrapped(official)).toEqual(wrapped(coder));
    write('Y');
    expect(wrapped(official)).toEqual(wrapped(coder));
    official.free();
  });
});

describe('engine parity on scrolled views', () => {
  const lines = (from: number, to: number) => {
    let s = '';
    for (let i = from; i <= to; i++) {
      s += `\x1b[38;5;${i % 256}mline ${i}\x1b[0m ${'x'.repeat(i % 50)}\r\n`;
    }
    return s;
  };
  // Unlimited scrollback on both, so both keep the same rows.
  const config = { ...THEME, scrollbackLimit: 0 };

  test('getLine, getScrollbackLine and the shown rows match at several offsets', async () => {
    const { coder, official } = await engines(80, 24, config);
    coder.write(lines(1, 300));
    official.write(lines(1, 300));
    expect(official.getScrollbackLength()).toBe(coder.getScrollbackLength());
    const sb = coder.getScrollbackLength();
    for (const k of [0, 1, 5, 23, 24, 25, 100, sb]) {
      expect(diffRows(shownRows(coder, k), shownRows(official, k))).toEqual([]);
      for (const y of [0, 10, 23]) {
        expect(diffRows([activeRow(coder, y)], [activeRow(official, y)])).toEqual([]);
      }
    }
    official.setViewportOffset?.(40);
    for (let i = 0; i < sb; i += 7) {
      expect(diffRows([scrollbackRow(coder, i)], [scrollbackRow(official, i)])).toEqual([]);
    }
    expect(diffRows(screen(coder).grid, screen(official).grid)).toEqual([]);
    official.free();
  });

  test('a write while scrolled snaps to the bottom, and a stale offset moves back', async () => {
    const { coder, official } = await engines(80, 24, config);
    coder.write(lines(1, 200));
    official.write(lines(1, 200));
    shownRows(official, 30);
    coder.write(lines(201, 210));
    official.write(lines(201, 210));
    expect(official.isRowDirty(0)).toBe(true);
    expect(diffRows(screen(coder).grid, screen(official).grid)).toEqual([]);
    // The awaitingEcho render passes the stale viewportY.
    expect(diffRows(shownRows(coder, 30), shownRows(official, 30))).toEqual([]);
    expect(diffRows(shownRows(coder, 0), shownRows(official, 0))).toEqual([]);
    official.free();
  });

  test('a resize while scrolled reflows the same rows', async () => {
    const { coder, official } = await engines(80, 24, config);
    coder.write(lines(1, 200));
    official.write(lines(1, 200));
    shownRows(official, 30);
    // Shrinking rewraps the long lines on both engines.
    coder.resize(60, 20);
    official.resize(60, 20);
    expect(official.getScrollbackLength()).toBe(coder.getScrollbackLength());
    expect(diffRows(shownRows(coder, 30), shownRows(official, 30))).toEqual([]);
    expect(diffRows(screen(coder).grid, screen(official).grid)).toEqual([]);
    // Growing unwraps them again. Known difference: after growing, the Coder wasm's
    // getScrollbackLine returns stale cells past the old width (e.g. "line 1 x" then
    // garbage codepoints, or "line 142" with 48 x's instead of 42), so the official
    // engine is checked against the text that was written instead.
    shownRows(official, 30);
    coder.resize(100, 30);
    official.resize(100, 30);
    expect(official.getScrollbackLength()).toBe(coder.getScrollbackLength());
    const sb = official.getScrollbackLength();
    const written = (i: number) => `line ${i} ${'x'.repeat(i % 50)}`.trimEnd();
    const expected = Array.from({ length: 30 }, (_, y) => written(sb - 30 + y + 1));
    expect(shownRows(official, 30).map(text)).toEqual(expected);
    expect(shownRows(coder, 30).map(text)).not.toEqual(expected);
    for (let i = 0; i < sb; i++) expect(text(scrollbackRow(official, i))).toBe(written(i + 1));
    expect(diffRows(screen(coder).grid, screen(official).grid)).toEqual([]);
    official.free();
  });

  test('a page read between a write and the next render loses no dirty rows', async () => {
    const { coder, official } = await engines(80, 24, config);
    coder.write(lines(1, 100));
    official.write(lines(1, 100));
    screen(official);
    coder.write('\x1b[5;3HCHANGED');
    official.write('\x1b[5;3HCHANGED');
    // A selection copy or buffer read above the viewport before the frame.
    expect(diffRows([scrollbackRow(coder, 3)], [scrollbackRow(official, 3)])).toEqual([]);
    expect(official.isRowDirty(4)).toBe(true);
    expect(official.isRowDirty(10)).toBe(false);
    expect(text(activeRow(official, 4))).toContain('CHANGED');
    expect(diffRows(screen(coder).grid, screen(official).grid)).toEqual([]);
    official.free();
  });

  test('stepping the offset through the screen keeps pages across moves, not writes', async () => {
    const { coder, official } = await engines(80, 24, config);
    coder.write(lines(1, 300));
    official.write(lines(1, 300));
    const sb = coder.getScrollbackLength();
    const walk = (ks: number[]) => {
      for (const k of ks) {
        expect(diffRows(shownRows(coder, k), shownRows(official, k))).toEqual([]);
        // The renderer's active rows come from one getViewport per frame.
        expect(diffRows(screen(coder).grid, screen(official).grid)).toEqual([]);
      }
    };
    const steps = [0, 1, 2, 12, 22, 23, 24, 25, 47, 48, 49, 100, sb, 30, 23, 1, 0];
    walk(steps);
    // An in-place write below the view, then the same walk: no page from before it.
    for (const t of [coder, official]) {
      t.setViewportOffset?.(10);
      t.write('\x1b[24;1HAFTER\x1b[1;1HTOP');
    }
    walk(steps);
    official.free();
  });

  test('a page read after an in-place write does not return stale cells', async () => {
    const { coder, official } = await engines(80, 24, config);
    coder.write(lines(1, 100));
    official.write(lines(1, 100));
    // Scrolled by 10: the bottom 10 active rows are below the view, read as a page.
    shownRows(official, 10);
    expect(text(activeRow(official, 23))).toBe(text(activeRow(coder, 23)));
    coder.write('\x1b[24;1HIN PLACE');
    official.write('\x1b[24;1HIN PLACE');
    expect(diffRows(shownRows(coder, 10), shownRows(official, 10))).toEqual([]);
    expect(text(activeRow(official, 23))).toStartWith('IN PLACE');
    expect(diffRows([activeRow(coder, 23)], [activeRow(official, 23)])).toEqual([]);
    official.free();
  });
});

describe('coder/ghostty-web#180 stress payload on the official engine', () => {
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

  test('0 stale rows over 300 repetitions', async () => {
    const cols = 160;
    const rows = 39;
    const t = (await Ghostty.load(OFFICIAL_WASM, 'official')).createTerminal(cols, rows, {
      scrollbackLimit: 10_000_000,
    });
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
