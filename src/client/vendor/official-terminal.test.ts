import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DirtyState,
  Ghostty,
  type GhosttyTerminal,
  OfficialGhostty,
  type OfficialTerminal,
} from './ghostty-web/ghostty';
import {
  CellFlags,
  Key,
  KeyAction,
  KeyEncoderOption,
  KittyKeyFlags,
  Mods,
} from './ghostty-web/types';

// The official libghostty-vt binding (ADR 042) on the vendored wasm, loaded from disk.

const OFFICIAL_WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

const FG = 0xd4d4d4;
const BG = 0x1e1e1e;
const RED = 0xcd3131;
const BLUE = 0x2472c8;
const THEME = {
  scrollbackLimit: 10000,
  fgColor: FG,
  bgColor: BG,
  palette: [0x000000, RED, 0x0dbc79, 0xe5e510, BLUE],
};

let vt: Ghostty;

beforeAll(async () => {
  vt = await Ghostty.load(OFFICIAL_WASM, 'official');
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

/** The text of a row as an app would see it: graphemes joined, spacer cells skipped. */
function rowText(t: GhosttyTerminal, y: number): string {
  const line = t.getLine(y);
  if (!line) return '';
  return line
    .map((c, x) => {
      if (c.width === 0) return '';
      if (c.grapheme_len > 0) return t.getGraphemeString(y, x);
      return c.codepoint ? String.fromCodePoint(c.codepoint) : ' ';
    })
    .join('')
    .trimEnd();
}

function scrollbackText(t: GhosttyTerminal, offset: number): string {
  const line = t.getScrollbackLine(offset);
  if (!line) return '';
  return line
    .map((c, x) => {
      if (c.width === 0) return '';
      if (c.grapheme_len > 0) return t.getScrollbackGraphemeString(offset, x);
      return c.codepoint ? String.fromCodePoint(c.codepoint) : ' ';
    })
    .join('')
    .trimEnd();
}

const rgb = (c: { fg_r: number; fg_g: number; fg_b: number }) =>
  (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b;
const bgRgb = (c: { bg_r: number; bg_g: number; bg_b: number }) =>
  (c.bg_r << 16) | (c.bg_g << 8) | c.bg_b;

describe('official engine: cells', () => {
  test('reads 16-colour, 256-colour and truecolor foregrounds and backgrounds', () => {
    const t = term();
    t.write(
      '\x1b[31mA\x1b[0m\x1b[38;5;208mB\x1b[0m\x1b[38;2;10;20;30;48;2;200;100;50mC\x1b[0m' +
        '\x1b[44mD\x1b[0mE\x1b[48;5;21m  \x1b[0m',
    );
    const line = t.getLine(0);
    expect(line).not.toBeNull();
    const [a, b, c, d, e, f] = line ?? [];
    expect(rgb(a)).toBe(RED);
    expect(bgRgb(a)).toBe(BG);
    expect(rgb(b)).toBe(0xff8700);
    expect(rgb(c)).toBe(0x0a141e);
    expect(bgRgb(c)).toBe(0xc86432);
    expect(bgRgb(d)).toBe(BLUE);
    expect(rgb(d)).toBe(FG);
    expect(rgb(e)).toBe(FG);
    expect(bgRgb(e)).toBe(BG);
    // Spaces written with a 256-colour background.
    expect(f.codepoint).toBe(0x20);
    expect(bgRgb(f)).toBe(0x0000ff);
    t.free();
  });

  test('reads bold, italic, underline, strikethrough, inverse, faint, blink and invisible', () => {
    const t = term();
    t.write(
      '\x1b[1mA\x1b[0m\x1b[3mB\x1b[0m\x1b[4mC\x1b[0m\x1b[9mD\x1b[0m\x1b[7mE\x1b[0m' +
        '\x1b[2mF\x1b[0m\x1b[5mG\x1b[0m\x1b[8mH\x1b[0m\x1b[1;3;4;7mI\x1b[0mJ',
    );
    const flags = (t.getLine(0) ?? []).slice(0, 10).map((c) => c.flags);
    expect(flags).toEqual([
      CellFlags.BOLD,
      CellFlags.ITALIC,
      CellFlags.UNDERLINE,
      CellFlags.STRIKETHROUGH,
      CellFlags.INVERSE,
      CellFlags.FAINT,
      CellFlags.BLINK,
      CellFlags.INVISIBLE,
      CellFlags.BOLD | CellFlags.ITALIC | CellFlags.UNDERLINE | CellFlags.INVERSE,
      0,
    ]);
    t.free();
  });

  test('reads wide CJK, emoji, VS16 and combining marks as graphemes', () => {
    const t = term();
    t.write('你好|😀|❤️|é|👨‍👩‍👧');
    const line = t.getLine(0) ?? [];
    expect(line.slice(0, 5).map((c) => c.width)).toEqual([2, 0, 2, 0, 1]);
    expect(String.fromCodePoint(line[0].codepoint)).toBe('你');
    expect(line[5].width).toBe(2);
    expect(String.fromCodePoint(line[5].codepoint)).toBe('😀');
    // VS16 makes the heart wide (mode 2027 on by default).
    expect(line[8].width).toBe(2);
    expect(line[8].grapheme_len).toBe(1);
    expect(t.getGraphemeString(0, 8)).toBe('❤️');
    expect(line[11].grapheme_len).toBe(1);
    expect(t.getGraphemeString(0, 11)).toBe('é');
    expect(t.getGrapheme(0, 11)).toEqual([0x65, 0x301]);
    expect(t.getGraphemeString(0, 13)).toBe('👨‍👩‍👧');
    expect(line[13].width).toBe(2);
    expect(rowText(t, 0)).toBe('你好|😀|❤️|é|👨‍👩‍👧');
    t.free();
  });

  test('marks OSC 8 hyperlinks and resolves their URIs on screen and in scrollback', () => {
    const t = term(40, 5);
    t.write('\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ plain');
    expect((t.getLine(0) ?? []).slice(0, 6).map((c) => c.hyperlink_id)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(t.getHyperlinkUri(0, 0)).toBe('https://example.com/a');
    expect(t.getHyperlinkUri(0, 5)).toBeNull();
    t.write('\r\n'.repeat(10));
    expect(t.getScrollbackLength()).toBeGreaterThan(0);
    expect(t.getScrollbackHyperlinkUri(0, 3)).toBe('https://example.com/a');
    expect(t.getScrollbackHyperlinkUri(0, 6)).toBeNull();
    // Longer than the first buffer tried.
    const long = `https://example.com/${'p'.repeat(1500)}`;
    t.write(`\x1b]8;;${long}\x1b\\long\x1b]8;;\x1b\\`);
    expect(t.getHyperlinkUri(t.getCursor().y, 0)).toBe(long);
    t.free();
  });

  test('uses an explicitly black theme background instead of the default', () => {
    const t = term(40, 5, {
      fgColor: FG,
      bgColor: 0,
      colorsSet: { foreground: true, background: true },
    });
    expect(t.getColors().background).toEqual({ r: 0, g: 0, b: 0 });
    t.write('\x1b]11;?\x07');
    expect(t.readResponse()).toBe('\x1b]11;rgb:0000/0000/0000\x07');
    t.free();
  });

  // Ghostty's render state copies the default colours only when both are set, so the
  // binding always sets both, falling back to the Coder engine's 0xcccccc on black.
  const hex = (c: { r: number; g: number; b: number } | null) =>
    c ? (c.r << 16) | (c.g << 8) | c.b : null;
  const defaults = (t: GhosttyTerminal) => {
    t.write('\x1b[1;1HA');
    t.update();
    const cell = (t.getLine(0) ?? [])[0];
    const colors = t.getColors();
    t.readResponse();
    t.write('\x1b]10;?\x07');
    const osc10 = t.readResponse();
    t.write('\x1b]11;?\x07');
    const osc11 = t.readResponse();
    return {
      fg: hex(colors.foreground),
      bg: hex(colors.background),
      cellFg: rgb(cell),
      cellBg: bgRgb(cell),
      osc10,
      osc11,
    };
  };

  test('falls back to the default background when only the foreground is given', () => {
    for (const config of [
      { fgColor: FG, bgColor: 0, colorsSet: { foreground: true } },
      { fgColor: FG, bgColor: 0 },
    ]) {
      const t = term(10, 3, config);
      expect(defaults(t)).toEqual({
        fg: FG,
        bg: 0,
        cellFg: FG,
        cellBg: 0,
        osc10: '\x1b]10;rgb:d4d4/d4d4/d4d4\x07',
        osc11: '\x1b]11;rgb:0000/0000/0000\x07',
      });
      t.free();
    }
  });

  test('falls back to the default foreground when only the background is given', () => {
    const t = term(10, 3, { bgColor: 0x202020, colorsSet: { background: true } });
    expect(defaults(t)).toEqual({
      fg: 0xcccccc,
      bg: 0x202020,
      cellFg: 0xcccccc,
      cellBg: 0x202020,
      osc10: '\x1b]10;rgb:cccc/cccc/cccc\x07',
      osc11: '\x1b]11;rgb:2020/2020/2020\x07',
    });
    t.free();
  });

  test('without theme colours still applies OSC 11 and DECSCNM', () => {
    for (const config of [undefined, { scrollbackLimit: 1000 }]) {
      const t = vt.createTerminal(10, 3, config) as OfficialTerminal;
      expect(defaults(t)).toEqual({
        fg: 0xcccccc,
        bg: 0,
        cellFg: 0xcccccc,
        cellBg: 0,
        osc10: '\x1b]10;rgb:cccc/cccc/cccc\x07',
        osc11: '\x1b]11;rgb:0000/0000/0000\x07',
      });
      t.write('\x1b]11;rgb:20/40/60\x1b\\');
      t.update();
      expect(bgRgb((t.getLine(0) ?? [])[0])).toBe(0x204060);
      expect(hex(t.getColors().background)).toBe(0x204060);
      t.write('\x1b]111\x1b\\\x1b[?5h');
      t.update();
      expect(bgRgb((t.getLine(0) ?? [])[0])).toBe(0xcccccc);
      expect(rgb((t.getLine(0) ?? [])[0])).toBe(0);
      t.free();
    }
  });
});

describe('official engine: cursor and modes', () => {
  test('reports the cursor in active-screen cells', () => {
    const t = term();
    t.write('ab\r\ncde');
    expect(t.getCursor()).toMatchObject({ x: 3, y: 1, visible: true });
    t.write('\x1b[?25l');
    expect(t.getCursor().visible).toBe(false);
    t.free();
  });

  test('applies DECSCUSR styles', () => {
    const t = term();
    t.write('\x1b[5 q');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    t.write('\x1b[2 q');
    expect(t.getCursor()).toMatchObject({ style: 'block', blinking: false });
    t.write('\x1b[4 q');
    expect(t.getCursor()).toMatchObject({ style: 'underline', blinking: false });
    t.write('\x1b[0 q');
    expect(t.getCursor().style).toBe('block');
    t.free();
  });

  test('switches to the alternate screen and back', () => {
    const t = term(20, 4);
    t.write('main');
    t.write('\x1b[?1049h');
    expect(t.isAlternateScreen()).toBe(true);
    t.write('\x1b[Halt');
    expect(rowText(t, 0)).toBe('alt');
    expect(t.getScrollbackLength()).toBe(0);
    t.write('\x1b[?1049l');
    expect(t.isAlternateScreen()).toBe(false);
    expect(rowText(t, 0)).toBe('main');
    t.free();
  });

  test('reports mouse tracking and the other DEC and ANSI modes', () => {
    const t = term();
    expect(t.hasMouseTracking()).toBe(false);
    t.write('\x1b[?1000h');
    expect(t.hasMouseTracking()).toBe(true);
    expect(t.getMode(1000)).toBe(true);
    t.write('\x1b[?1002h\x1b[?1006h');
    expect(t.getMode(1002)).toBe(true);
    expect(t.getMode(1006)).toBe(true);
    expect(t.getMode(1003)).toBe(false);
    t.write('\x1b[?1003h');
    expect(t.getMode(1003)).toBe(true);
    t.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l');
    expect(t.hasMouseTracking()).toBe(false);
    t.write('\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b[4h');
    expect(t.hasBracketedPaste()).toBe(true);
    expect(t.hasFocusEvents()).toBe(true);
    expect(t.getMode(1)).toBe(true);
    expect(t.getMode(4, true)).toBe(true);
    expect(t.getMode(4, false)).toBe(false);
    t.free();
  });
});

describe('official engine: scrollback, resize and the viewport', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n');

  test('keeps scrolled-off rows, oldest first', () => {
    const t = term(20, 5, { scrollbackLimit: 0 });
    t.write(lines(50));
    expect(t.getScrollbackLength()).toBe(45);
    expect(scrollbackText(t, 0)).toBe('line 1');
    expect(scrollbackText(t, 44)).toBe('line 45');
    expect(t.getScrollbackLine(45)).toBeNull();
    expect(rowText(t, 0)).toBe('line 46');
    expect(rowText(t, 4)).toBe('line 50');
    t.free();
  });

  test('keeps active-screen coordinates while the view is scrolled up', () => {
    const t = term(20, 5, { scrollbackLimit: 0 });
    t.write(lines(50));
    t.setViewportOffset(7);
    expect(t.isRowDirty(0)).toBe(true);
    expect(rowText(t, 0)).toBe('line 46');
    expect(rowText(t, 4)).toBe('line 50');
    expect(scrollbackText(t, 38)).toBe('line 39');
    expect(scrollbackText(t, 44)).toBe('line 45');
    const viewport = t.getViewport();
    expect(viewport.length).toBe(100);
    expect(String.fromCodePoint(viewport[80 + 5].codepoint)).toBe('5');
    expect(t.getCursor()).toMatchObject({ x: 7, y: 4 });
    // Output snaps the view back to the bottom.
    t.write('\r\nline 51');
    expect(rowText(t, 4)).toBe('line 51');
    expect(t.needsFullRedraw()).toBe(true);
    t.free();
  });

  test('reflows wrapped lines on resize', () => {
    const t = term(20, 5);
    t.write('abcdefghijklmnopqrstuvwxyz0123');
    expect(rowText(t, 0)).toBe('abcdefghijklmnopqrst');
    expect(rowText(t, 1)).toBe('uvwxyz0123');
    // Coder semantics: a row is wrapped when it continues the row above.
    expect(t.isRowWrapped(0)).toBe(false);
    expect(t.isRowWrapped(1)).toBe(true);
    t.resize(30, 5);
    expect(t.getDimensions()).toEqual({ cols: 30, rows: 5 });
    expect(rowText(t, 0)).toBe('abcdefghijklmnopqrstuvwxyz0123');
    expect(t.getLine(0)?.length).toBe(30);
    t.resize(12, 6);
    expect([rowText(t, 0), rowText(t, 1), rowText(t, 2)]).toEqual([
      'abcdefghijkl',
      'mnopqrstuvwx',
      'yz0123',
    ]);
    expect(t.cols).toBe(12);
    expect(t.rows).toBe(6);
    t.free();
  });

  test('keeps row dirt until markClean and only marks changed rows', () => {
    const t = term(20, 5);
    t.write('one\r\ntwo\r\nthree');
    t.update();
    t.markClean();
    expect(t.update()).toBe(DirtyState.NONE);
    t.write('\x1b[2;1HTWO');
    expect(t.update()).toBe(DirtyState.PARTIAL);
    expect(t.update()).toBe(DirtyState.PARTIAL);
    expect(t.isRowDirty(1)).toBe(true);
    expect(t.isRowDirty(0)).toBe(false);
    expect(t.isRowDirty(3)).toBe(false);
    expect(rowText(t, 1)).toBe('TWO');
    t.clearDirty();
    expect(t.isRowDirty(1)).toBe(false);
    t.write('\x1b[?1049h');
    expect(t.needsFullRedraw()).toBe(true);
    t.free();
  });

  // Ghostty marks no row dirty when only the default colours change; the binding bakes
  // them into every cell, so it must redecode every row itself.
  const everyCell = (t: GhosttyTerminal, rows: number, f: (c: never) => number) =>
    Array.from({ length: rows }, (_, y) => (t.getLine(y) ?? []).map((c) => f(c as never)));

  test('recolours every row when OSC 10/11 change only the default colours', () => {
    const t = term(10, 3);
    t.write('a\r\nb\r\nc');
    t.update();
    t.markClean();
    t.write('\x1b]11;rgb:44/55/66\x1b\\');
    expect(t.update()).toBe(DirtyState.FULL);
    for (let y = 0; y < 3; y++) expect(t.isRowDirty(y)).toBe(true);
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(0x445566));
    t.markClean();
    t.write('\x1b]10;rgb:11/22/33\x1b\\');
    expect(t.update()).toBe(DirtyState.FULL);
    expect(everyCell(t, 3, rgb).flat()).toEqual(Array(30).fill(0x112233));
    t.write('\x1b[1;1HX');
    t.update();
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(0x445566));
    t.markClean();
    t.write('\x1b]111\x1b\\\x1b]110\x1b\\');
    t.update();
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(BG));
    expect(everyCell(t, 3, rgb).flat()).toEqual(Array(30).fill(FG));
    t.free();
  });

  test('recolours every row on DECSCNM (?5h / ?5l)', () => {
    const t = term(10, 3);
    t.write('a\r\nb\r\nc');
    t.update();
    t.markClean();
    t.write('\x1b[?5h');
    expect(t.update()).toBe(DirtyState.FULL);
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(FG));
    t.markClean();
    t.write('\x1b[2;1HB');
    t.update();
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(FG));
    t.markClean();
    t.write('\x1b[?5l');
    expect(t.update()).toBe(DirtyState.FULL);
    expect(everyCell(t, 3, bgRgb).flat()).toEqual(Array(30).fill(BG));
    expect(everyCell(t, 3, rgb).flat()).toEqual(Array(30).fill(FG));
    t.free();
  });
});

describe('official engine: effects and replies', () => {
  test('reports the title and the bell once', () => {
    const t = term();
    t.write('\x1b]2;first\x07');
    expect(t.readEffects()).toEqual({ bell: false, title: 'first' });
    t.write('\x07\x1b]0;second\x1b\\');
    expect(t.readEffects()).toEqual({ bell: true, title: 'second' });
    expect(t.readEffects()).toEqual({ bell: false, title: null });
    t.free();
  });

  test('answers DA1, DA2, DSR, XTWINOPS and DECRQM through WRITE_PTY', () => {
    const t = term(80, 24);
    t.setCellPixelSize(9, 18);
    const ask = (q: string) => {
      t.write(q);
      return t.readResponse();
    };
    expect(t.hasResponse()).toBe(false);
    expect(ask('\x1b[c')).toBe('\x1b[?62;22c');
    expect(ask('\x1b[>c')).toBe('\x1b[>1;10;0c');
    expect(ask('\x1b[5n')).toBe('\x1b[0n');
    expect(ask('\x1b[3;7H\x1b[6n')).toBe('\x1b[3;7R');
    expect(ask('\x1b[14t')).toBe('\x1b[4;432;720t');
    expect(ask('\x1b[16t')).toBe('\x1b[6;18;9t');
    expect(ask('\x1b[18t')).toBe('\x1b[8;24;80t');
    expect(ask('\x1b[?2027$p')).toBe('\x1b[?2027;1$y');
    expect(ask('\x1b[c\x1b[5n')).toBe('\x1b[?62;22c\x1b[0n');
    expect(t.readResponse()).toBeNull();
    t.free();
  });

  test('sends one mode 2048 report per real size change', () => {
    const t = term(80, 24);
    t.setCellPixelSize(9, 18);
    t.write('\x1b[?2048h');
    expect(t.readResponse()).toBe('\x1b[48;24;80;432;720t');
    t.resize(100, 30, 9, 18);
    expect(t.readResponse()).toBe('\x1b[48;30;100;540;900t');
    t.resize(100, 30, 9, 18);
    t.setCellPixelSize(9, 18);
    expect(t.readResponse()).toBeNull();
    t.setCellPixelSize(10, 20);
    expect(t.readResponse()).toBe('\x1b[48;30;100;600;1000t');
    t.free();
  });

  test('makes one ghostty_terminal_resize call per grid or pixel change', async () => {
    const wasm = await WebAssembly.instantiate(await Bun.file(OFFICIAL_WASM).arrayBuffer(), {});
    const real = wasm.instance.exports as Record<string, unknown>;
    let resizes = 0;
    const resize = real.ghostty_terminal_resize as (...args: number[]) => number;
    const spy = {
      ...real,
      ghostty_terminal_resize: (...args: number[]) => {
        resizes++;
        return resize(...args);
      },
    };
    const engine = new OfficialGhostty(
      spy as unknown as ConstructorParameters<typeof OfficialGhostty>[0],
    );
    const t = engine.createTerminal(80, 24);
    // open(): the initial cell size.
    t.setCellPixelSize(9, 18);
    expect(resizes).toBe(1);
    // Repeated fits with nothing changed.
    t.setCellPixelSize(9, 18);
    t.resize(80, 24, 9, 18);
    expect(resizes).toBe(1);
    // A zoom that changes grid and pixels: one call.
    t.resize(90, 26, 10, 20);
    t.setCellPixelSize(10, 20);
    expect(resizes).toBe(2);
    // A zoom or DPR change that keeps the grid: one call.
    t.resize(90, 26, 11, 22);
    t.setCellPixelSize(11, 22);
    expect(resizes).toBe(3);
    t.free();
  });
});

describe('official engine: memory growth', () => {
  test('reads correct cells and replies after the wasm memory has grown', () => {
    const t = term(120, 40, { scrollbackLimit: 0 });
    const memory = (vt as OfficialGhostty).ex.memory;
    const before = memory.buffer.byteLength;
    let i = 0;
    while (memory.buffer.byteLength === before && i < 200000) {
      let chunk = '';
      for (let j = 0; j < 500; j++, i++) {
        chunk += `\x1b[38;2;${i % 256};${(i >> 8) % 256};${(i * 7) % 256}mrow ${i}\x1b[0m\r\n`;
      }
      t.write(chunk);
    }
    expect(memory.buffer.byteLength).toBeGreaterThan(before);
    t.write('\x1b[6n');
    expect(t.readResponse()).toBe('\x1b[40;1R');
    expect(rowText(t, 38)).toBe(`row ${i - 1}`);
    const cell = t.getLine(38)?.[0];
    expect(cell && rgb(cell)).toBe(
      (((i - 1) % 256) << 16) | ((((i - 1) >> 8) % 256) << 8) | (((i - 1) * 7) % 256),
    );
    expect(scrollbackText(t, 0)).toBe('row 0');
    t.free();
  });
});

describe('official engine: key encoder', () => {
  test('encodes keys by their official names', () => {
    const enc = vt.createKeyEncoder();
    const encode = (key: Key, mods = Mods.NONE, utf8?: string) =>
      new TextDecoder().decode(enc.encode({ action: KeyAction.PRESS, key, mods, utf8 }));
    expect(encode(Key.UP)).toBe('\x1b[A');
    expect(encode(Key.ENTER)).toBe('\r');
    expect(encode(Key.C, Mods.CTRL, 'c')).toBe('\x03');
    expect(encode(Key.ONE, Mods.NONE, '1')).toBe('1');
    expect(encode(Key.GRAVE, Mods.NONE, '`')).toBe('`');
    expect(encode(Key.F1)).toBe('\x1bOP');
    expect(encode(Key.PASTE)).toBe('');
    enc.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
    expect(encode(Key.UP)).toBe('\x1bOA');
    enc.setKittyFlags(KittyKeyFlags.DISAMBIGUATE);
    expect(encode(Key.ESCAPE)).toBe('\x1b[27u');
    enc.dispose();
  });
});
