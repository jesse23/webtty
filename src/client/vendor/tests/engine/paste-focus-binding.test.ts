import { beforeAll, describe, expect, test } from 'bun:test';
import type { Ghostty, GhosttyTerminal, OfficialTerminal } from '../../ghostty-web/ghostty';
import { THEME } from '../support/terminal-text';
import { loadGhostty } from '../support/wasm';

// The wasm paste and focus encoders (ADR 049, ADR 053, ADR 061): bracketed and plain
// pastes made safe, and focus reports, tested through OfficialTerminal.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

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
