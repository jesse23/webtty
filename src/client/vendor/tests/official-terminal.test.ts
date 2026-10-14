import { beforeAll, describe, expect, test } from 'bun:test';
import {
  DirtyState,
  Ghostty,
  type GhosttyTerminal,
  type MouseInput,
  type OfficialTerminal,
} from '../ghostty-web/ghostty';
import { CellFlags, Key, KeyAction, KeyEncoderOption, Mods } from '../ghostty-web/types';
import { instantiateWasm, loadGhostty } from './support/wasm';

// The official libghostty-vt binding (ADR 042) on the vendored wasm, loaded from disk.

const FG = 0xd4d4d4;
const BG = 0x1e1e1e;
const RED = 0xcd3131;
const BLUE = 0x2472c8;
const THEME = {
  fgColor: FG,
  bgColor: BG,
  palette: [0x000000, RED, 0x0dbc79, 0xe5e510, BLUE],
};

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
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
    expect([...t.getGraphemeString(0, 11)].map((c) => c.codePointAt(0))).toEqual([0x65, 0x301]);
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
    const t = term(40, 5, { fgColor: FG, bgColor: 0 });
    t.write('\x1b]11;?\x07');
    expect(t.readResponse()).toBe('\x1b]11;rgb:0000/0000/0000\x07');
    t.free();
  });

  test("sets a black palette entry as black and keeps Ghostty's default for an unset one", () => {
    const fgs = (config: object) => {
      const t = term(10, 3, config);
      t.write('\x1b[30mA\x1b[31mB');
      t.update();
      const line = t.getLine(0) ?? [];
      t.free();
      return [rgb(line[0]), rgb(line[1])];
    };
    const ghosttyBlack = fgs({})[0];
    expect(ghosttyBlack).not.toBe(0);
    expect(fgs({ palette: [0x000000, RED] })).toEqual([0, RED]);
    expect(fgs({ palette: [undefined, RED] })).toEqual([ghosttyBlack, RED]);
  });

  // Ghostty's render state copies the default colours only when both are set, so the
  // binding always sets both, falling back to webtty's default 0xcccccc on black.
  const defaults = (t: GhosttyTerminal) => {
    t.write('\x1b[1;1HA');
    t.update();
    const cell = (t.getLine(0) ?? [])[0];
    t.readResponse();
    t.write('\x1b]10;?\x07');
    const osc10 = t.readResponse();
    t.write('\x1b]11;?\x07');
    const osc11 = t.readResponse();
    return {
      cellFg: rgb(cell),
      cellBg: bgRgb(cell),
      osc10,
      osc11,
    };
  };

  test('falls back to the default background when only the foreground is given', () => {
    for (const config of [{ fgColor: FG }, { fgColor: FG, bgColor: undefined }]) {
      const t = term(10, 3, config);
      expect(defaults(t)).toEqual({
        cellFg: FG,
        cellBg: 0,
        osc10: '\x1b]10;rgb:d4d4/d4d4/d4d4\x07',
        osc11: '\x1b]11;rgb:0000/0000/0000\x07',
      });
      t.free();
    }
  });

  test('falls back to the default foreground when only the background is given', () => {
    const t = term(10, 3, { bgColor: 0x202020 });
    expect(defaults(t)).toEqual({
      cellFg: 0xcccccc,
      cellBg: 0x202020,
      osc10: '\x1b]10;rgb:cccc/cccc/cccc\x07',
      osc11: '\x1b]11;rgb:2020/2020/2020\x07',
    });
    t.free();
  });

  test('without theme colours still applies OSC 11 and DECSCNM', () => {
    for (const config of [undefined, { scrollbackLines: 1000 }]) {
      const t = vt.createTerminal(10, 3, config) as OfficialTerminal;
      expect(defaults(t)).toEqual({
        cellFg: 0xcccccc,
        cellBg: 0,
        osc10: '\x1b]10;rgb:cccc/cccc/cccc\x07',
        osc11: '\x1b]11;rgb:0000/0000/0000\x07',
      });
      t.write('\x1b]11;rgb:20/40/60\x1b\\');
      t.update();
      expect(bgRgb((t.getLine(0) ?? [])[0])).toBe(0x204060);
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

  test('the configured cursor is the default that Ps 0 and RIS restore (ADR 049)', () => {
    const t = term(40, 10, { ...THEME, cursorStyle: 'bar', cursorBlink: true });
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    t.write('\x1b[2 q');
    expect(t.getCursor()).toMatchObject({ style: 'block', blinking: false });
    t.write('\x1b[0 q');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    t.write('\x1b[4 q\x1bc');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    t.free();
  });

  test('a new default shows at once only while the app has not set a shape', () => {
    const t = term();
    expect(t.getCursor()).toMatchObject({ style: 'block', blinking: false });
    t.setDefaultCursor('underline', true);
    expect(t.getCursor()).toMatchObject({ style: 'underline', blinking: true });
    t.write('\x1b[6 q');
    t.setDefaultCursor('block', false);
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: false });
    t.write('\x1b[ q');
    expect(t.getCursor()).toMatchObject({ style: 'block', blinking: false });
    t.free();
  });

  test('mode 12 does not change the blink; DECSCUSR does, and Ps 0 restores the config', () => {
    const t = term(40, 10, { ...THEME, cursorStyle: 'bar', cursorBlink: true });
    // vim's t_vs / t_ve, as Ghostty with cursor-style-blink set (ADR 049)
    t.write('\x1b[?12l\x1b[?25h');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    expect(t.getMode(12)).toBe(true);
    t.write('\x1b[?12h');
    expect(t.getCursor().blinking).toBe(true);
    // DECSCUSR steady, then mode 12 on in the same chunk and in the next
    t.write('\x1b[2 q\x1b[?12h');
    expect(t.getCursor()).toMatchObject({ style: 'block', blinking: false });
    t.write('\x1b[?12;25h');
    expect(t.getCursor().blinking).toBe(false);
    t.write('\x1b[1 q\x1b[?12l');
    expect(t.getCursor()).toMatchObject({ style: 'block', blinking: true });
    t.write('\x1b[4 q');
    expect(t.getCursor()).toMatchObject({ style: 'underline', blinking: false });
    t.write('\x1b[?12h\x1b[0 q\x1b[?12l');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    // A DECSCUSR split across writes, after the blink default changed
    t.setDefaultCursor('bar', false);
    expect(t.getCursor().blinking).toBe(false);
    t.write('\x1b[5 ');
    t.write('q\x1b[?12l');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: true });
    t.write('\x1b');
    t.write('c\x1b[?12h');
    expect(t.getCursor()).toMatchObject({ style: 'bar', blinking: false });
    t.free();
  });

  test('follows Ghostty: the shape is per screen, DECSTR restores', () => {
    const t = term();
    t.write('\x1b[6 q');
    t.write('\x1b[?1049h\x1b[2 q');
    expect(t.getCursor().style).toBe('block');
    t.write('\x1b[?1049l');
    expect(t.getCursor().style).toBe('bar');
    // A sequence split across writes, and Ps out of range
    t.write('\x1b[4');
    t.write(' q\x1b[7 q');
    expect(t.getCursor().style).toBe('underline');
    t.write('\x1b[!p');
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
    expect(t.getMode(2004)).toBe(true);
    expect(t.getMode(1004)).toBe(true);
    expect(t.getMode(1)).toBe(true);
    expect(t.getMode(4, true)).toBe(true);
    expect(t.getMode(4, false)).toBe(false);
    t.free();
  });
});

describe('official engine: scrollback, resize and the viewport', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n');

  test('keeps scrolled-off rows, oldest first', () => {
    const t = term(20, 5, { scrollbackLines: 0 });
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
    const t = term(20, 5, { scrollbackLines: 0 });
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

  test('a scroll step decodes nothing and moves no viewport once its page is cached', async () => {
    const real = (await instantiateWasm()).exports as Record<string, (...args: number[]) => number>;
    const calls = { update: 0, rows: 0, scroll: 0 };
    const counted =
      (name: string, key: keyof typeof calls) =>
      (...args: number[]) => {
        calls[key]++;
        return real[name](...args);
      };
    const spy = {
      ...real,
      ghostty_render_state_update: counted('ghostty_render_state_update', 'update'),
      ghostty_render_state_row_get_multi: counted('ghostty_render_state_row_get_multi', 'rows'),
      ghostty_terminal_scroll_viewport: counted('ghostty_terminal_scroll_viewport', 'scroll'),
    };
    const spied = new Ghostty(spy as unknown as ConstructorParameters<typeof Ghostty>[0]);
    const t = spied.createTerminal(20, 5, { scrollbackLines: 0 });
    t.write(lines(50));
    const sb = t.getScrollbackLength();
    expect(sb).toBe(45);
    // One frame as the renderer reads it at viewportY = k.
    const frame = (k: number) => {
      t.setViewportOffset(k);
      t.getCursor();
      t.needsFullRedraw();
      const view = t.getViewport();
      const shown: string[] = [];
      for (let y = 0; y < t.rows; y++) {
        if (y < k) {
          const line = t.getScrollbackLine(sb - k + y) ?? [];
          for (let x = 0; x < line.length; x++) t.getScrollbackGraphemeString(sb - k + y, x);
          shown.push(
            line
              .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
              .join('')
              .trimEnd(),
          );
        } else {
          const row = view.slice((y - k) * t.cols, (y - k + 1) * t.cols);
          shown.push(
            row
              .map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' '))
              .join('')
              .trimEnd(),
          );
        }
        t.isRowDirty(y);
      }
      t.markClean();
      return shown;
    };
    const expected = (k: number) =>
      Array.from({ length: 5 }, (_, y) => `line ${50 - 5 - k + y + 1}`);
    frame(0);
    // The first walk reads each scrollback page once: 45 rows in pages of 5.
    const first = { ...calls };
    for (let k = 1; k <= sb; k++) expect(frame(k)).toEqual(expected(k));
    expect(calls.update - first.update).toBe(9);
    expect(calls.rows - first.rows).toBe(9 * 5);
    // Each page read moves the viewport there and back; nothing else moves it.
    expect(calls.scroll - first.scroll).toBe(9 * 2);
    // Every page is cached now: a walk back down and up again costs no export call.
    const warm = { ...calls };
    for (let k = sb; k >= 0; k--) expect(frame(k)).toEqual(k ? expected(k) : expected(0));
    for (let k = 0; k <= sb + 10; k++) frame(k);
    expect(calls).toEqual(warm);
    // Output while scrolled: one refresh of the active rows, no viewport move, and
    // the first frame at the bottom repaints every row.
    t.setViewportOffset(12);
    t.write('\r\nline 51');
    expect(t.needsFullRedraw()).toBe(true);
    expect(calls.update - warm.update).toBe(1);
    expect(calls.scroll).toBe(warm.scroll);
    expect(rowText(t, 4)).toBe('line 51');
    t.markClean();
    // Resize while scrolled: no viewport move, and the reflowed rows are read anew.
    t.setViewportOffset(12);
    const beforeResize = calls.scroll;
    t.resize(30, 4);
    expect(calls.scroll).toBe(beforeResize);
    expect(t.getScrollbackLength()).toBe(47);
    expect(scrollbackText(t, 46)).toBe('line 47');
    expect(rowText(t, 3)).toBe('line 51');
    t.free();
  });

  test('reflows wrapped lines on resize', () => {
    const t = term(20, 5);
    t.write('abcdefghijklmnopqrstuvwxyz0123');
    expect(rowText(t, 0)).toBe('abcdefghijklmnopqrst');
    expect(rowText(t, 1)).toBe('uvwxyz0123');
    // A row is wrapped when it continues the row above (ghostty-web's semantics).
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

describe('official engine: scrollback in lines (ADR 046)', () => {
  /** Writes `n` numbered lines and returns how many scrollback rows the terminal kept. */
  function keep(config: object | undefined, n: number, cols = 80): number {
    const t = vt.createTerminal(cols, 24, config) as OfficialTerminal;
    let chunk = '';
    for (let i = 0; i < n; i++) {
      chunk += `line ${i}\r\n`;
      if (chunk.length > 1 << 20) {
        t.write(chunk);
        chunk = '';
      }
    }
    t.write(chunk);
    t.update();
    const kept = t.getScrollbackLength();
    t.free();
    return kept;
  }

  test('keeps about scrollbackLines lines, a page at most under', () => {
    const kept = keep({ scrollbackLines: 10000 }, 15000);
    expect(kept).toBeGreaterThan(9000);
    expect(kept).toBeLessThanOrEqual(10000 + 200);
  });

  test('scrollbackLines 0 removes the line limit', () => {
    expect(keep({ scrollbackLines: 0 }, 20000)).toBe(20000 - 24 + 1);
  });

  test('without scrollbackLines keeps the default 10,000 lines', () => {
    for (const config of [undefined, THEME]) {
      const kept = keep(config, 15000);
      expect(kept).toBeGreaterThan(9000);
      expect(kept).toBeLessThanOrEqual(10000 + 200);
    }
  });
});

describe('official engine: effects and replies', () => {
  test('reports the title and the bell once', () => {
    const t = term();
    t.write('\x1b]2;first\x07');
    expect(t.readEffects()).toEqual({
      bell: false,
      title: 'first',
      clipboard: null,
      notifications: [],
    });
    t.write('\x07\x1b]0;second\x1b\\');
    expect(t.readEffects()).toEqual({
      bell: true,
      title: 'second',
      clipboard: null,
      notifications: [],
    });
    expect(t.readEffects()).toEqual({
      bell: false,
      title: null,
      clipboard: null,
      notifications: [],
    });
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

  test('does not answer the kitty keyboard query', () => {
    // Keys are never encoded with the kitty flags, so the protocol must not look on.
    const t = term();
    t.write('\x1b[?u');
    expect(t.readResponse()).toBeNull();
    t.write('\x1b[>31u\x1b[?u');
    expect(t.readResponse()).toBeNull();
    // Replies around it still arrive, in order.
    t.write('\x1b[c\x1b[?u\x1b[5n');
    expect(t.readResponse()).toBe('\x1b[?62;22c\x1b[0n');
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
    const real = (await instantiateWasm()).exports as Record<string, unknown>;
    let resizes = 0;
    const resize = real.ghostty_terminal_resize as (...args: number[]) => number;
    const spy = {
      ...real,
      ghostty_terminal_resize: (...args: number[]) => {
        resizes++;
        return resize(...args);
      },
    };
    const spied = new Ghostty(spy as unknown as ConstructorParameters<typeof Ghostty>[0]);
    const t = spied.createTerminal(80, 24);
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

describe('official engine: clipboard writes (ADR 052)', () => {
  const b64 = (bytes: string | Uint8Array) => Buffer.from(bytes).toString('base64');
  /** The clipboard text one write reports, or null for none. */
  function copied(seq: string, config: object = THEME): string | null {
    const t = term(80, 24, config);
    t.write(seq);
    const { clipboard } = t.readEffects();
    expect(t.readEffects().clipboard).toBeNull();
    // OSC 52 has no reply: nothing is ever sent back, query or write.
    expect(t.readResponse()).toBeNull();
    t.free();
    return clipboard;
  }

  test('OSC 52 to the clipboard, ended by BEL or ST, decoded as UTF-8', () => {
    expect(copied(`\x1b]52;c;${b64('hello')}\x07`)).toBe('hello');
    expect(copied(`\x1b]52;c;${b64('héllo 中文 🎉\nline 2')}\x1b\\`)).toBe('héllo 中文 🎉\nline 2');
  });

  test('an empty or unknown selection is the clipboard, as in Ghostty', () => {
    expect(copied(`\x1b]52;;${b64('x')}\x07`)).toBe('x');
    expect(copied(`\x1b]52;0;${b64('zero')}\x07`)).toBe('zero');
  });

  test('the selection and primary clipboards are not written', () => {
    expect(copied(`\x1b]52;s;${b64('sel')}\x07`)).toBeNull();
    expect(copied(`\x1b]52;p;${b64('pri')}\x07`)).toBeNull();
    // Ghostty takes one selection character only.
    expect(copied(`\x1b]52;pc;${b64('both')}\x07`)).toBeNull();
  });

  test('an empty payload clears the clipboard', () => {
    expect(copied('\x1b]52;c;\x07')).toBe('');
  });

  test('a query is never answered', () => {
    expect(copied('\x1b]52;c;?\x07')).toBeNull();
  });

  test('invalid base64 is ignored whole; missing padding is accepted', () => {
    expect(copied('\x1b]52;c;!!!!\x07')).toBeNull();
    expect(copied(`\x1b]52;c;${b64('ok').slice(0, 3)}?\x07`)).toBeNull();
    expect(copied('\x1b]52;c;aGk\x07')).toBe('hi');
  });

  test('bytes that are not UTF-8 become U+FFFD', () => {
    expect(copied(`\x1b]52;c;${b64(new Uint8Array([0x61, 0xff, 0x62]))}\x07`)).toBe('a\ufffdb');
  });

  test('iTerm2 OSC 1337 Copy reaches the clipboard too', () => {
    expect(copied(`\x1b]1337;Copy=:${b64('iterm')}\x07`)).toBe('iterm');
  });

  test('a sequence split across writes is reported when it ends; the last write wins', () => {
    const t = term();
    t.write(`\x1b]52;c;${b64('split')}`);
    expect(t.readEffects().clipboard).toBeNull();
    t.write(`\x07\x1b]52;c;${b64('first')}\x07\x1b]52;c;${b64('last')}\x07`);
    expect(t.readEffects().clipboard).toBe('last');
    t.free();
  });

  test('a sequence over 8 MiB is dropped, and the terminal carries on', () => {
    const t = term();
    const fits = 'a'.repeat(5 * 1024 * 1024);
    t.write(`\x1b]52;c;${b64(fits)}\x07`);
    expect(t.readEffects().clipboard?.length).toBe(fits.length);
    t.write(`\x1b]52;c;${b64('a'.repeat(6 * 1024 * 1024))}\x07after`);
    expect(t.readEffects().clipboard).toBeNull();
    expect(rowText(t, 0)).toBe('after');
    t.free();
  });

  test('with clipboardWrite off, nothing is reported', () => {
    const off = { ...THEME, clipboardWrite: false };
    expect(copied(`\x1b]52;c;${b64('hello')}\x07`, off)).toBeNull();
    expect(copied('\x1b]52;c;\x07', off)).toBeNull();
    expect(copied(`\x1b]1337;Copy=:${b64('iterm')}\x07`, off)).toBeNull();
  });
});

describe('official engine: focus reports (ADR 053)', () => {
  test('encodes focus gained and lost as CSI I and CSI O', () => {
    const t = term();
    const text = (focused: boolean) => new TextDecoder().decode(t.encodeFocus(focused));
    expect(text(true)).toBe('\x1b[I');
    expect(text(false)).toBe('\x1b[O');
    // The engine sends nothing itself when the mode is set: the embedder does.
    t.write('\x1b[?1004h');
    expect(t.getMode(1004)).toBe(true);
    expect(t.readResponse()).toBeNull();
    t.free();
  });
});

describe('official engine: cursor at a prompt (ADR 054)', () => {
  test('follows OSC 133 marks, and is false without them and on the alternate screen', () => {
    const t = term();
    t.write('$ ');
    expect(t.cursorAtPrompt()).toBe(false);
    t.write('\r\n\x1b]133;A\x07~ > \x1b]133;B\x07ls');
    expect(t.cursorAtPrompt()).toBe(true);
    t.write('\x1b[?1049h');
    expect(t.cursorAtPrompt()).toBe(false);
    t.write('\x1b[?1049l');
    expect(t.cursorAtPrompt()).toBe(true);
    // The command runs: its output is not a prompt
    t.write('\r\n\x1b]133;C\x07output\r\nmore');
    expect(t.cursorAtPrompt()).toBe(false);
    t.free();
  });

  test('writeUntilGround writes up to the end of a cut-off sequence', () => {
    const t = term();
    const bytes = (s: string) => new TextEncoder().encode(s);
    expect(t.writeUntilGround(bytes(''))).toBe(0);
    expect(t.writeUntilGround(bytes('ab'))).toBe(0);
    t.write('a\x1b[3');
    expect(t.writeUntilGround(new Uint8Array(0))).toBeNull();
    expect(t.writeUntilGround(bytes('1;'))).toBeNull();
    expect(t.writeUntilGround(bytes('2mbc'))).toBe(2);
    t.write('\x1b]2;ti');
    expect(t.writeUntilGround(bytes('tle\x07x'))).toBe(4);
    // A multi-byte character cut in two is a sequence too
    t.write(new Uint8Array([0xc3]));
    expect(t.writeUntilGround(new Uint8Array([0xa9, 0x41]))).toBe(1);
    t.free();
  });
});

describe('official engine: desktop notifications (ADR 056)', () => {
  /** The notifications one write reports. */
  function notified(seq: string, config: object = THEME) {
    const t = term(80, 24, config);
    t.write(seq);
    const { notifications } = t.readEffects();
    expect(t.readEffects().notifications).toEqual([]);
    // Neither sequence has a reply.
    expect(t.readResponse()).toBeNull();
    t.free();
    return notifications;
  }

  test('OSC 9 is a notification with no title, ended by BEL or ST', () => {
    expect(notified('\x1b]9;Build done\x07')).toEqual([{ title: '', body: 'Build done' }]);
    expect(notified('\x1b]9;héllo 中文 🎉; with; semicolons\x1b\\')).toEqual([
      { title: '', body: 'héllo 中文 🎉; with; semicolons' },
    ]);
  });

  test('OSC 777;notify has a title and a body; the body may hold semicolons', () => {
    expect(notified('\x1b]777;notify;Claude Code;Needs your input\x07')).toEqual([
      { title: 'Claude Code', body: 'Needs your input' },
    ]);
    expect(notified('\x1b]777;notify;t;a;b\x07')).toEqual([{ title: 't', body: 'a;b' }]);
    expect(notified('\x1b]777;notify;;body\x07')).toEqual([{ title: '', body: 'body' }]);
  });

  test("ConEmu's OSC 9;<n> forms are not notifications", () => {
    for (const seq of [
      '9;4;1;50', // progress
      '9;4;0',
      '9;1;100', // sleep
      '9;2;message box',
      '9;3;tab title',
      '9;5', // wait for input
      '9;6;macro',
      '9;7;cmd',
      '9;8;PATH',
      '9;9;/tmp',
      '9;10',
      '9;11;comment',
      '9;12', // prompt start
    ]) {
      expect(notified(`\x1b]${seq}\x07`)).toEqual([]);
    }
  });

  test('an OSC 9 that only looks like ConEmu is a notification, as in Ghostty', () => {
    expect(notified('\x1b]9;4\x07')).toEqual([{ title: '', body: '4' }]);
    expect(notified('\x1b]9;42 tests passed\x07')).toEqual([
      { title: '', body: '42 tests passed' },
    ]);
  });

  test('OSC 777 other than notify, or with no title, is ignored', () => {
    expect(notified('\x1b]777;other;a;b\x07')).toEqual([]);
    expect(notified('\x1b]777;notify;only a title\x07')).toEqual([]);
  });

  test('a sequence split across writes is reported when it ends', () => {
    const t = term();
    t.write('\x1b]777;notify;Do');
    expect(t.readEffects().notifications).toEqual([]);
    t.write('ne;all green\x07\x1b]9;second\x07');
    expect(t.readEffects().notifications).toEqual([
      { title: 'Done', body: 'all green' },
      { title: '', body: 'second' },
    ]);
    t.free();
  });

  test('with desktopNotifications off, nothing is reported', () => {
    const off = { ...THEME, desktopNotifications: false };
    expect(notified('\x1b]9;Build done\x07', off)).toEqual([]);
    expect(notified('\x1b]777;notify;t;b\x07', off)).toEqual([]);
  });
});

describe('official engine: memory growth', () => {
  test('reads correct cells and replies after the wasm memory has grown', () => {
    const t = term(120, 40, { scrollbackLines: 0 });
    const memory = vt.ex.memory;
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
    enc.dispose();
  });
});

describe('official engine: mouse encoder (ADR 049)', () => {
  // A 40x10 grid of 10 px cells with 5 px of padding on every side: the screen is
  // 410x110, and cell (col, row) 1-based spans x 5+10(col-1) .. 5+10col.
  const GEOMETRY = {
    screenWidth: 410,
    screenHeight: 110,
    cellWidth: 10,
    cellHeight: 10,
    paddingTop: 5,
    paddingRight: 5,
    paddingBottom: 5,
    paddingLeft: 5,
  };
  const at = (col: number, row: number) => ({ x: 5 + 10 * col - 5, y: 5 + 10 * row - 5 });
  const tracking = (modes: string, cols = 40) => {
    const t = term(cols, 10);
    t.write(modes);
    t.setMouseGeometry({ ...GEOMETRY, screenWidth: 10 + 10 * cols });
    return t;
  };
  const report = (
    t: GhosttyTerminal,
    action: MouseInput['action'],
    button: MouseInput['button'],
    pos: { x: number; y: number },
    mods = Mods.NONE,
    anyButtonPressed = action === 'press',
  ) =>
    new TextDecoder('latin1').decode(
      t.encodeMouse({ action, button, mods, ...pos, anyButtonPressed }),
    );

  test('SGR clicks carry Shift, Alt and Ctrl, not Super', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'left', at(3, 2))).toBe('\x1b[<0;3;2M');
    expect(report(t, 'release', 'left', at(3, 2))).toBe('\x1b[<0;3;2m');
    expect(report(t, 'press', 'left', at(3, 2), Mods.ALT)).toBe('\x1b[<8;3;2M');
    expect(report(t, 'press', 'left', at(3, 2), Mods.SUPER)).toBe('\x1b[<0;3;2M');
    expect(report(t, 'press', 'right', at(3, 2), Mods.SHIFT | Mods.CTRL)).toBe('\x1b[<22;3;2M');
    expect(report(t, 'press', 'middle', at(3, 2))).toBe('\x1b[<1;3;2M');
    t.free();
  });

  test('back and forward are buttons 8 and 9 (128, 129)', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'eight', at(1, 1))).toBe('\x1b[<128;1;1M');
    expect(report(t, 'release', 'nine', at(1, 1))).toBe('\x1b[<129;1;1m');
    t.free();
  });

  test('the wheel is buttons 4 and 5 in the format the app chose', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'four', at(7, 4), Mods.NONE, false)).toBe('\x1b[<64;7;4M');
    expect(report(t, 'press', 'five', at(7, 4), Mods.CTRL, false)).toBe('\x1b[<81;7;4M');
    t.write('\x1b[?1006l');
    expect(report(t, 'press', 'four', at(7, 4), Mods.NONE, false)).toBe("\x1b[M`'$");
    t.free();
  });

  test('any-event tracking reports hover as 35, once per cell', () => {
    const t = tracking('\x1b[?1003h\x1b[?1006h');
    const hover = (x: number, y: number) => report(t, 'motion', null, { x, y });
    expect(hover(26, 16)).toBe('\x1b[<35;3;2M');
    expect(hover(29, 19)).toBe('');
    expect(hover(36, 19)).toBe('\x1b[<35;4;2M');
    // A press sets the last cell too
    expect(report(t, 'press', 'left', at(5, 2))).toBe('\x1b[<0;5;2M');
    expect(report(t, 'motion', 'left', at(5, 2), Mods.NONE, true)).toBe('');
    expect(report(t, 'motion', 'left', at(6, 2), Mods.NONE, true)).toBe('\x1b[<32;6;2M');
    t.free();
  });

  test('a mode change resets the last cell', () => {
    const t = tracking('\x1b[?1003h\x1b[?1006h');
    expect(report(t, 'motion', null, at(2, 2))).toBe('\x1b[<35;2;2M');
    expect(report(t, 'motion', null, at(2, 2))).toBe('');
    // The format last set wins
    t.write('\x1b[?1015h');
    expect(report(t, 'motion', null, at(2, 2))).toBe('\x1b[67;2;2M');
    t.free();
  });

  test('normal tracking (1000) reports no motion, button tracking (1002) only drags', () => {
    const t = tracking('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'motion', 'left', at(2, 2), Mods.NONE, true)).toBe('');
    t.write('\x1b[?1002h');
    expect(report(t, 'motion', null, at(3, 2))).toBe('');
    expect(report(t, 'motion', 'left', at(3, 2), Mods.NONE, true)).toBe('\x1b[<32;3;2M');
    t.free();
  });

  test('X10 mode 9 reports presses of left, middle and right only, without modifiers', () => {
    const t = tracking('\x1b[?9h');
    expect(report(t, 'press', 'left', at(5, 3), Mods.SHIFT)).toBe('\x1b[M %#');
    expect(report(t, 'release', 'left', at(5, 3))).toBe('');
    expect(report(t, 'press', 'four', at(5, 3), Mods.NONE, false)).toBe('');
    expect(report(t, 'press', 'eight', at(5, 3))).toBe('');
    t.free();
  });

  test('X10 format: releases are button 3, and columns past 95 need bytes above 0x7f', () => {
    const t = tracking('\x1b[?1000h', 120);
    expect(report(t, 'press', 'left', at(5, 3), Mods.ALT)).toBe('\x1b[M(%#');
    expect(report(t, 'release', 'left', at(5, 3))).toBe('\x1b[M#%#');
    expect(report(t, 'press', 'left', at(95, 1))).toBe('\x1b[M \x7f!');
    expect([
      ...t.encodeMouse({
        action: 'press',
        button: 'left',
        mods: 0,
        ...at(96, 1),
        anyButtonPressed: true,
      }),
    ]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0x21]);
    t.free();
  });

  test('UTF-8 (1005), urxvt (1015) and SGR-pixels (1016) formats', () => {
    const t = tracking('\x1b[?1000h\x1b[?1005h', 300);
    const utf8 = new TextDecoder().decode(
      t.encodeMouse({
        action: 'press',
        button: 'left',
        mods: 0,
        ...at(200, 3),
        anyButtonPressed: true,
      }),
    );
    expect(utf8).toBe(`\x1b[M ${String.fromCodePoint(232)}#`);
    t.write('\x1b[?1005l\x1b[?1015h');
    expect(report(t, 'press', 'left', at(200, 3))).toBe('\x1b[32;200;3M');
    t.write('\x1b[?1015l\x1b[?1016h');
    // Pixels from the grid's origin, not the screen's
    expect(report(t, 'press', 'left', { x: 26, y: 17 })).toBe('\x1b[<0;21;12M');
    expect(report(t, 'release', 'left', { x: 2, y: 17 })).toBe('\x1b[<0;-3;12m');
    t.free();
  });

  test('the padding is the nearest edge cell; outside the screen only drags and releases', () => {
    const t = tracking('\x1b[?1002h\x1b[?1006h');
    expect(report(t, 'press', 'left', { x: 1, y: 1 })).toBe('\x1b[<0;1;1M');
    expect(report(t, 'press', 'left', { x: 408, y: 108 })).toBe('\x1b[<0;40;10M');
    // Dragged past the right edge: clamped to the edge cell
    expect(report(t, 'motion', 'left', { x: 600, y: 50 }, Mods.NONE, true)).toBe('\x1b[<32;40;5M');
    expect(report(t, 'motion', 'left', { x: -50, y: 50 }, Mods.NONE, true)).toBe('\x1b[<32;1;5M');
    expect(report(t, 'release', 'left', { x: -50, y: 50 }, Mods.NONE, false)).toBe('\x1b[<0;1;5m');
    // Outside with no button held: nothing
    expect(report(t, 'motion', null, { x: -50, y: 60 }, Mods.NONE, false)).toBe('');
    expect(report(t, 'press', 'left', { x: -50, y: 60 }, Mods.NONE, false)).toBe('');
    t.free();
  });

  test('no tracking reports nothing, and a reset terminal starts without tracking', () => {
    const t = tracking('');
    expect(report(t, 'press', 'left', at(1, 1))).toBe('');
    t.write('\x1b[?1000h\x1b[?1006h');
    expect(report(t, 'press', 'left', at(1, 1))).toBe('\x1b[<0;1;1M');
    t.write('\x1bc');
    expect(report(t, 'press', 'left', at(1, 1))).toBe('');
    t.free();
  });
});

describe('official engine: paste (ADR 049)', () => {
  const paste = (t: GhosttyTerminal, text: string) => {
    t.paste(text);
    return t.readResponse();
  };

  test('brackets every paste while mode 2004 is on, single lines too', () => {
    const t = term();
    t.write('\x1b[?2004h');
    expect(paste(t, 'hello')).toBe('\x1b[200~hello\x1b[201~');
    expect(paste(t, 'one\ntwo\r\n')).toBe('\x1b[200~one\ntwo\r\n\x1b[201~');
    t.free();
  });

  test('without 2004, sends the text with newlines as CR', () => {
    const t = term();
    expect(paste(t, 'hello')).toBe('hello');
    expect(paste(t, 'one\ntwo')).toBe('one\rtwo');
    expect(paste(t, 'one\r\ntwo\n')).toBe('one\r\rtwo\r');
    t.free();
  });

  test('replaces unsafe control bytes with spaces in both modes, keeping tabs', () => {
    const t = term();
    const unsafe = 'a\x00b\x08c\x1bd\x7fe\x03f\x15g\x1ah\x16i\x17j\tk';
    expect(paste(t, unsafe)).toBe('a b c d e f g h i j\tk');
    t.write('\x1b[?2004h');
    // An end marker inside the text cannot end the paste early
    expect(paste(t, 'x\x1b[201~rm -rf ~\n')).toBe('\x1b[200~x [201~rm -rf ~\n\x1b[201~');
    t.free();
  });

  test('passes UTF-8 through, and an empty paste writes nothing', () => {
    const t = term();
    expect(paste(t, 'héllo 中 🙂')).toBe('héllo 中 🙂');
    expect(paste(t, '')).toBeNull();
    t.free();
  });

  test('a large paste arrives whole and in order', () => {
    const t = term();
    t.write('\x1b[?2004h');
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    expect(paste(t, text)).toBe(`\x1b[200~${text}\x1b[201~`);
    t.free();
  });
});

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

describe('official engine: OSC 133 prompts (ADR 057)', () => {
  /** A command as fish 4 marks it: prompt, command line, output, end. */
  const command = (name: string, lines: number) =>
    `\x1b]133;A\x07$ \x1b]133;B\x07${name}\r\n\x1b]133;C\x07` +
    Array.from({ length: lines }, (_, i) => `${name} ${i}`).join('\r\n') +
    '\r\n\x1b]133;D;0\x07';
  /** Prompts on rows 0, 7 and 14, and the current one on row 21 of 22. */
  const session = () => {
    const t = term(20, 5);
    t.write(`${command('one', 6)}${command('two', 6)}${command('three', 6)}\x1b]133;A\x07$ `);
    return t;
  };

  test('promptJumpRow moves the top row by prompts, as Ghostty, and stops at either end', () => {
    const t = session();
    expect(t.getScrollbackLength()).toBe(17);
    // Up from the bottom: the nearest prompt above the top row
    expect(t.promptJumpRow(17, -1)).toBe(14);
    expect(t.promptJumpRow(14, -1)).toBe(7);
    expect(t.promptJumpRow(17, -2)).toBe(7);
    expect(t.promptJumpRow(7, -5)).toBe(0);
    expect(t.promptJumpRow(0, -1)).toBe(0);
    expect(t.promptJumpRow(10, -1)).toBe(7);
    // Down past the last prompt in the scrollback: the bottom
    expect(t.promptJumpRow(0, 1)).toBe(7);
    expect(t.promptJumpRow(14, 1)).toBe(17);
    expect(t.promptJumpRow(17, 1)).toBe(17);
    expect(t.promptJumpRow(10, 0)).toBe(10);
    t.free();
  });

  test('promptJumpRow leaves the viewport at the bottom, so output and reads are unchanged', () => {
    const t = session();
    t.promptJumpRow(17, -2);
    expect(rowText(t, 4)).toBe('$');
    expect(scrollbackText(t, 7)).toBe('$ two');
    t.write('ls');
    expect(rowText(t, 4)).toBe('$ ls');
    t.free();
  });

  test('promptJumpRow does nothing without marks or on the alternate screen', () => {
    const t = term(20, 5);
    t.write(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'));
    expect(t.getScrollbackLength()).toBe(25);
    expect(t.promptJumpRow(25, -1)).toBe(25);
    expect(t.promptJumpRow(10, 1)).toBe(10);
    t.free();
    const alt = session();
    alt.write('\x1b[?1049h');
    expect(alt.promptJumpRow(0, -1)).toBe(0);
    alt.free();
  });

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

describe('official engine: search (ADR 055)', () => {
  /** Runs the search to completion and returns its matches as [col, row, col, row] tuples. */
  function run(t: OfficialTerminal): number[][] {
    while (t.searchStep(50)) {}
    const m = t.searchMatches();
    return Array.from({ length: m.length / 4 }, (_, i) => Array.from(m.slice(i * 4, i * 4 + 4)));
  }

  test('finds ASCII letters case-insensitively, newest first, scrollback included', () => {
    const t = term(20, 3);
    t.write('Error one\r\nok\r\nerror two\r\nok\r\nERROR three');
    t.setSearch('error');
    expect(run(t)).toEqual([
      [0, 4, 4, 4],
      [0, 2, 4, 2],
      [0, 0, 4, 0],
    ]);
    expect(t.getScrollbackLength()).toBe(2);
    expect(t.searchState()).toEqual({ total: 3, selected: null });
    t.free();
  });

  test('a match spans a soft wrap', () => {
    const t = term(5, 3);
    t.write('abcdefg');
    t.setSearch('def');
    expect(run(t)).toEqual([[3, 0, 0, 1]]);
    t.free();
  });

  test('next moves toward older output and wraps; previous moves back', () => {
    const t = term(10, 4);
    t.write('a x\r\nb x\r\nc x');
    t.setSearch('x');
    run(t);
    const row = () => t.searchSelectedMatch()?.start.row;
    expect(t.searchSelectedMatch()).toBeNull();
    expect(t.searchSelect('next')).toBe(true);
    expect([t.searchState().selected, row()]).toEqual([0, 2]);
    t.searchSelect('next');
    expect([t.searchState().selected, row()]).toEqual([1, 1]);
    t.searchSelect('next');
    t.searchSelect('next');
    expect([t.searchState().selected, row()]).toEqual([0, 2]);
    t.searchSelect('previous');
    expect([t.searchState().selected, row()]).toEqual([2, 0]);
    expect(t.searchSelectedMatch()).toEqual({ start: { col: 2, row: 0 }, end: { col: 2, row: 0 } });
    t.free();
  });

  test('picks up output after a step, and leaves the view alone', () => {
    const t = term(10, 3);
    t.write('x\r\n');
    t.setSearch('x');
    expect(run(t)).toHaveLength(1);
    expect(t.searchStep(50)).toBe(false);
    t.write('x\r\nx\r\nx\r\n');
    expect(run(t)).toHaveLength(4);
    t.searchSelect('previous');
    expect(t.searchSelectedMatch()?.start.row).toBe(0);
    // SCROLL_NONE: the top row of Ghostty's viewport is still the active screen's
    expect(t.getLine(0)?.[0].codepoint).toBe('x'.codePointAt(0));
    t.free();
  });

  test('a new needle restarts the search; an empty one ends it', () => {
    const t = term(10, 3);
    t.write('foo bar');
    t.setSearch('foo');
    expect(run(t)).toEqual([[0, 0, 2, 0]]);
    t.setSearch('BAR');
    expect(run(t)).toEqual([[4, 0, 6, 0]]);
    t.setSearch('');
    expect(t.searchStep(50)).toBe(false);
    expect(t.searchMatches()).toHaveLength(0);
    expect(t.searchState()).toEqual({ total: 0, selected: null });
    expect(t.searchSelect('next')).toBe(false);
    t.free();
  });

  test('matches pruned from the scrollback go away', () => {
    const t = term(10, 2, { scrollbackLines: 1000 });
    t.write('x0\r\n');
    t.setSearch('x');
    expect(run(t)).toHaveLength(1);
    t.write('y\r\n'.repeat(5000));
    expect(run(t)).toHaveLength(0);
    t.free();
  });

  test('reads more matches than its buffer held', () => {
    const t = term(40, 5, { scrollbackLines: 1000 });
    t.setSearch('ab');
    t.write('ab\r\n');
    expect(run(t)).toHaveLength(1);
    t.write('ab ab ab ab ab\r\n'.repeat(100));
    const all = run(t);
    expect(all).toHaveLength(501);
    expect(t.searchState().total).toBe(501);
    // Newest to oldest: rows never increase
    for (let i = 1; i < all.length; i++) expect(all[i][1]).toBeLessThanOrEqual(all[i - 1][1]);
    t.free();
  });
});
