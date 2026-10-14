import { beforeAll, describe, expect, test } from 'bun:test';
import { EngineEffects, effectsSlots } from '../../ghostty-web/engine/engine-effects';
import {
  FOCUS_REPORT_MAX,
  PasteFocusBinding,
  pasteFocusSlots,
} from '../../ghostty-web/engine/paste-focus-binding';
import type { Ghostty, GhosttyTerminal, OfficialTerminal } from '../../ghostty-web/ghostty';
import { bindingContext, freeContext, trackedHost } from '../support/engine-harness';
import { THEME } from '../support/terminal-text';
import { loadGhostty } from '../support/wasm';

// The wasm paste and focus encoders (ADR 049, ADR 053, ADR 061): bracketed and plain
// pastes made safe, and focus reports, through OfficialTerminal and directly.

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

describe('PasteFocusBinding', () => {
  test('installs its reader on the first paste only, and free() releases it once', () => {
    const { host, installs } = trackedHost(vt);
    const ctx = bindingContext(host, 10, 3, { ...pasteFocusSlots(), ...effectsSlots(host.L) });
    // The replies come back through WRITE_PTY, which the effects install
    const effects = new EngineEffects(ctx, { clipboardWrite: false, desktopNotifications: false });
    const before = installs.length;
    const binding = new PasteFocusBinding(ctx);
    expect(binding.encodeFocus(true)).toEqual(new TextEncoder().encode('\x1b[I'));
    expect(installs.length).toBe(before);
    binding.paste('a');
    binding.paste('b');
    expect(effects.readResponse()).toBe('ab');
    expect(installs.length).toBe(before + 1);
    ctx.ex.ghostty_terminal_free(ctx.term);
    ctx.term = 0;
    binding.free();
    binding.free();
    expect(installs[before].releases).toBe(1);
    effects.free();
    ctx.scratch.free();
  });

  test('a focus report fits its buffer', () => {
    const ctx = bindingContext(vt, 10, 3, pasteFocusSlots());
    const binding = new PasteFocusBinding(ctx);
    expect(binding.encodeFocus(false).length).toBeLessThanOrEqual(FOCUS_REPORT_MAX);
    binding.free();
    freeContext(ctx);
  });
});
