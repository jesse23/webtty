import { beforeAll, describe, expect, test } from 'bun:test';
import { EngineEffects, effectsSlots } from '../../ghostty-web/engine/engine-effects';
import type { Ghostty, OfficialTerminal } from '../../ghostty-web/ghostty';
import { bindingContext, trackedHost, writeVt } from '../support/engine-harness';
import { rowText, THEME } from '../support/terminal-text';
import { loadGhostty, wrappedGhostty } from '../support/wasm';

// What the engine reports back from the wasm callbacks (ADR 042, ADR 052, ADR 056, ADR 061):
// the title, the bell, replies through WRITE_PTY, clipboard writes and desktop
// notifications, through OfficialTerminal and directly.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

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

describe('EngineEffects', () => {
  test('installs the five callbacks plus the two the config can turn off', () => {
    for (const [on, count] of [
      [false, 5],
      [true, 7],
    ] as const) {
      const { host, installs } = trackedHost(vt);
      const ctx = bindingContext(host, 10, 3, effectsSlots(host.L));
      const effects = new EngineEffects(ctx, { clipboardWrite: on, desktopNotifications: on });
      expect(installs.length).toBe(count);
      ctx.ex.ghostty_terminal_free(ctx.term);
      ctx.term = 0;
      effects.free();
      effects.free();
      expect(installs.map((i) => i.releases)).toEqual(new Array(count).fill(1));
      ctx.scratch.free();
    }
  });

  test('the title is read after the write returns, and no callback re-enters the terminal', async () => {
    let depth = 0;
    const inside: string[] = [];
    const names = ['ghostty_terminal_vt_write', 'ghostty_terminal_get'];
    const ghostty = await wrappedGhostty(names, (name, fn) => (...args) => {
      if (depth > 0) inside.push(name);
      if (name !== 'ghostty_terminal_vt_write') return fn(...args);
      depth++;
      try {
        return fn(...args);
      } finally {
        depth--;
      }
    });
    const ctx = bindingContext(ghostty, 10, 3, effectsSlots(ghostty.L));
    const effects = new EngineEffects(ctx, { clipboardWrite: true, desktopNotifications: true });
    writeVt(ctx, '\x1b]2;hi\x07\x07\x1b[c\x1b[14t\x1b]52;c;YQ==\x07\x1b]9;n\x07');
    expect(effects.readEffects()).toEqual({
      bell: true,
      title: null,
      clipboard: 'a',
      notifications: [{ title: '', body: 'n' }],
    });
    effects.afterWrite();
    expect(effects.readEffects().title).toBe('hi');
    expect(effects.readResponse()).toBe('\x1b[?62;22c\x1b[4;0;0t');
    expect(inside).toEqual([]);
    ctx.ex.ghostty_terminal_free(ctx.term);
    ctx.term = 0;
    effects.free();
    ctx.scratch.free();
  });
});
