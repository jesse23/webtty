import { beforeAll, describe, expect, test } from 'bun:test';
import { Ghostty, type OfficialTerminal } from '../../ghostty-web/ghostty';
import { markedSession, rgb, rowText, scrollbackText, THEME } from '../support/terminal-text';
import { instantiateWasm, loadGhostty } from '../support/wasm';

// The official libghostty-vt terminal (ADR 042, ADR 061) on the vendored wasm: what the
// facade itself does: the cursor and modes, resize, writes, prompt jumps and memory growth.
// Its bindings are tested beside it in engine/, each through this facade.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

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

describe('official engine: prompt jumps (ADR 057)', () => {
  /** Prompts on rows 0, 7 and 14, and the current one on row 21 of 22. */
  const session = () => {
    const t = term(20, 5);
    t.write(markedSession());
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
});
