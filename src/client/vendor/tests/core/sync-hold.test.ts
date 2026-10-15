import { describe, expect, spyOn, test } from 'bun:test';
import { SYNC_HOLD_MAX_MS, SyncHold } from '../../ghostty-web/core/sync-hold';
import { engineOf, openTerminal, rendererOf } from '../support/terminal-harness';

// The hold on painting during a synchronized update (DEC mode 2026, ADR 067): its timing
// on a stand-in mode, and the real engine's mode through Terminal.renderHeld.

/** A hold over a stand-in mode 2026 that the writes below turn on and off. */
function standIn() {
  const mode = { on: false, ends: 0 };
  let now = 0;
  const hold = new SyncHold(
    {
      active: () => mode.on,
      end: () => {
        mode.on = false;
        mode.ends++;
      },
    },
    () => now,
  );
  /** Writes `data` at `at` ms, the mode following its last 2026 set or reset. */
  const write = (at: number, data: string) => {
    now = at;
    const last = Math.max(data.lastIndexOf('2026h'), data.lastIndexOf('2026l'));
    if (last >= 0) mode.on = data[last + 4] === 'h';
    hold.wrote(data);
  };
  return { mode, hold, write };
}

/** A printable key as the browser delivers it to the container. */
function keydown(key: string) {
  return {
    type: 'keydown',
    key,
    code: `Key${key.toUpperCase()}`,
    keyCode: key.toUpperCase().charCodeAt(0),
    isComposing: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
  };
}

const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';

describe('SyncHold', () => {
  test('holds from a begin until the end, for at most SYNC_HOLD_MAX_MS', () => {
    const { hold, write } = standIn();
    expect(hold.held(0)).toBe(false);
    write(100, `${BEGIN}half`);
    expect(hold.held(100 + SYNC_HOLD_MAX_MS - 1)).toBe(true);
    write(200, `drawn${END}`);
    expect(hold.held(201)).toBe(false);
  });

  test('back-to-back updates each get their own time, even in one write', () => {
    const { hold, write } = standIn();
    write(0, `${BEGIN}one${END}${BEGIN}two`);
    expect(hold.held(SYNC_HOLD_MAX_MS - 1)).toBe(true);
    write(900, `${END}${BEGIN}three`);
    // Timed from the second begin at 900, not the first at 0
    expect(hold.held(900 + SYNC_HOLD_MAX_MS - 1)).toBe(true);
  });

  test('every begin restarts the time, as in Ghostty, a repeated one inside an update too', () => {
    const { hold, write } = standIn();
    write(0, BEGIN);
    write(800, `more${BEGIN}`);
    expect(hold.held(1500)).toBe(true);
    expect(hold.held(800 + SYNC_HOLD_MAX_MS - 1)).toBe(true);
  });

  test('a begin split across writes is timed from the write that ends it', () => {
    const { mode, hold, write } = standIn();
    write(0, '\x1b[?20');
    mode.on = true;
    write(600, '26h');
    expect(hold.held(600 + SYNC_HOLD_MAX_MS - 1)).toBe(true);
  });

  test("an update past its time is ended once, by the render loop's expire, and the next begin holds again", () => {
    const { mode, hold, write } = standIn();
    write(0, `${BEGIN}stuck`);
    // Asking does not end it
    expect(hold.held(SYNC_HOLD_MAX_MS)).toBe(false);
    expect([mode.on, mode.ends]).toEqual([true, 0]);
    hold.expire(SYNC_HOLD_MAX_MS);
    expect([mode.on, mode.ends]).toEqual([false, 1]);
    hold.expire(SYNC_HOLD_MAX_MS + 16);
    expect(hold.held(SYNC_HOLD_MAX_MS + 16)).toBe(false);
    expect(mode.ends).toBe(1);
    write(5000, BEGIN);
    hold.expire(5016);
    expect(hold.held(5016)).toBe(true);
  });

  test('a mode turned on unseen (a C1 CSI) is timed from the first frame that sees it', () => {
    const { mode, hold } = standIn();
    mode.on = true;
    expect(hold.held(0)).toBe(true);
    hold.expire(300);
    expect(hold.held(300 + SYNC_HOLD_MAX_MS - 1)).toBe(true);
    hold.expire(300 + SYNC_HOLD_MAX_MS);
    expect(hold.held(300 + SYNC_HOLD_MAX_MS)).toBe(false);
    expect(mode.ends).toBe(1);
  });

  test('reset forgets the update and an unfinished begin', () => {
    const { mode, hold, write } = standIn();
    write(0, BEGIN);
    write(10, '\x1b[?20');
    hold.reset();
    mode.on = false;
    write(700, '26h');
    // Not a begin after the reset: the mode is on, timed from the first frame
    mode.on = true;
    hold.expire(800);
    expect(hold.held(800 + SYNC_HOLD_MAX_MS - 1)).toBe(true);
  });
});

describe('SyncHold paint point', () => {
  test('only after a held frame: past the last update that ends, until the terminal paints', () => {
    const { hold } = standIn();
    const data = `${BEGIN}1${END}${BEGIN}2`;
    expect(hold.paintPoint(data)).toBe(-1);
    hold.frameHeld();
    expect(hold.paintPoint(data)).toBe(BEGIN.length + 1 + END.length);
    expect(hold.paintPoint(`${BEGIN}still drawing`)).toBe(-1);
    hold.painted();
    expect(hold.paintPoint(data)).toBe(-1);
    hold.frameHeld();
    hold.reset();
    expect(hold.paintPoint(data)).toBe(-1);
  });
});

describe('Terminal.renderHeld', () => {
  test("follows the app's CSI ? 2026 h / l; the render loop paints nothing until the update ends", async () => {
    const h = await openTerminal();
    try {
      const { term, clock } = h;
      const render = spyOn(rendererOf(term), 'render');
      expect(term.renderHeld(clock.now())).toBe(false);
      term.write(`${BEGIN}half`);
      expect(term.renderHeld(clock.now())).toBe(true);
      render.mockClear();
      clock.frame();
      clock.frame();
      expect(render).not.toHaveBeenCalled();
      // Frames were held, so the update is painted as it ends, without a frame's wait
      term.write(` drawn${END}`);
      expect(term.renderHeld(clock.now())).toBe(false);
      expect(render).toHaveBeenCalledTimes(1);
      clock.frame();
      expect(render).toHaveBeenCalledTimes(2);
    } finally {
      h.close();
    }
  });

  test('an update never ended is turned off after a second: DECRQM, the echo and painting agree', async () => {
    const h = await openTerminal();
    try {
      const { term, clock, sent } = h;
      const render = spyOn(rendererOf(term), 'render');
      term.write(`${BEGIN}stuck`);
      // Typed input's echo waits while the update holds
      h.container.dispatch(keydown('a'));
      render.mockClear();
      term.write('a');
      expect(render).not.toHaveBeenCalled();
      clock.advance(SYNC_HOLD_MAX_MS);
      clock.frame();
      expect(render).toHaveBeenCalledTimes(1);
      expect(engineOf(term).getMode(2026)).toBe(false);
      term.write('\x1b[?2026$p');
      expect(sent.at(-1)).toBe('\x1b[?2026;2$y');
      // The echo renders at once again
      h.container.dispatch(keydown('b'));
      render.mockClear();
      term.write('b');
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  test('after a held frame, an update is painted as it ends, before the next one is written', async () => {
    const h = await openTerminal();
    try {
      const { term, clock } = h;
      const render = spyOn(rendererOf(term), 'render');
      const painted: number[] = [];
      term.onUpdatePainted(() => painted.push(render.mock.calls.length));
      term.write(`${BEGIN}first`);
      render.mockClear();
      clock.frame();
      expect(render).not.toHaveBeenCalled();
      // Back to back: the first ends and the second begins in one write
      term.write(` drawn${END}${BEGIN}second`);
      expect(render).toHaveBeenCalledTimes(1);
      expect(painted).toEqual([1]);
      expect(term.renderHeld(clock.now())).toBe(true);
      // Painted at that end, nothing waits until a frame is held again
      term.write(` drawn${END}${BEGIN}third`);
      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  test('reset replaces the engine and forgets its update; a replay ending inside one holds a second at most', async () => {
    const h = await openTerminal();
    try {
      const { term, clock } = h;
      term.write(`${BEGIN}old`);
      term.reset();
      expect(term.renderHeld(clock.now())).toBe(false);
      // The replay of a session captured mid-update
      term.write(`replayed${BEGIN}`);
      expect(term.renderHeld(clock.now())).toBe(true);
      clock.advance(SYNC_HOLD_MAX_MS);
      expect(term.renderHeld(clock.now())).toBe(false);
    } finally {
      h.close();
    }
  });
});
