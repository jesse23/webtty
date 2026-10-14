import { describe, expect, test } from 'bun:test';
import { fakeWebSocket } from '../test-support/fake-socket';
import { FakeTerminal } from '../test-support/fake-terminal';
import { FakeWindow } from '../test-support/fake-window';
import { ManualClock } from '../test-support/manual-clock';
import { connectPty, type PtyParts } from './connect-pty';

/** A connection on fakes whose parts and terminal log each call into one list. */
function connected() {
  const log: string[] = [];
  const term = new FakeTerminal();
  const sockets = fakeWebSocket();
  const clock = new ManualClock();
  const win = new FakeWindow('https://example.test/s/work');
  term.resyncFocus = () => log.push(`term.resyncFocus sent=${sockets.last().sent.length}`);
  term.write = (data) => log.push(`term.write ${String(data).length}`);
  term.reset = () => log.push('term.reset');
  const parts: PtyParts = {
    replay: {
      connected: () => log.push('replay.connected'),
      output: (chars) => log.push(`replay.output ${chars}`),
      parsed: () => log.push('replay.parsed'),
    },
    graphics: {
      reset: () => log.push(`graphics.reset sent=${sockets.last().sent.length}`),
      feed: (data) => log.push(`graphics.feed ${data}`),
    },
    smoothScroll: { onOutput: () => log.push('smoothScroll.onOutput') },
    connected: () => log.push('clipboard.connected'),
  };
  const connection = connectPty(
    'work',
    term.asTerminal(),
    {
      window: win.asWindow(),
      WebSocket: sockets.WebSocket,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      performance: { now: clock.now },
    },
    parts,
  );
  return { log, sockets, clock, win, connection };
}

describe('connectPty', () => {
  test('connects at once to the session, telling the clipboard and then the replay', () => {
    const { log, sockets } = connected();
    expect(sockets.last().url).toBe('wss://example.test/ws/work/pty?cols=80&rows=24&flow=1');
    expect(log).toEqual(['clipboard.connected', 'replay.connected']);
  });

  test('on open: graphics start over, the size goes out, then the focus is resynced', () => {
    const { log, sockets } = connected();
    log.length = 0;
    sockets.last().open();
    expect(log).toEqual(['graphics.reset sent=0', 'term.resyncFocus sent=1']);
    expect(sockets.last().sent).toEqual([JSON.stringify({ type: 'resize', cols: 80, rows: 24 })]);
  });

  test('each message runs the pipeline in order, and its ack follows on the clock', () => {
    const { log, sockets, clock } = connected();
    const socket = sockets.last();
    socket.open();
    log.length = 0;
    socket.receive('hello');
    expect(log).toEqual([
      'replay.output 5',
      'graphics.feed hello',
      'replay.parsed',
      'smoothScroll.onOutput',
    ]);
    clock.advance(100);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'ack', chars: 5 }));
  });

  test('a closed socket stops its ack timer before the reconnect', () => {
    const { sockets, clock } = connected();
    const socket = sockets.last();
    socket.open();
    socket.receive('hello');
    socket.serverClose(1006);
    expect(clock.pending.timers).toBe(1);
    clock.advance(2000);
    expect(sockets.sockets).toHaveLength(2);
    expect(socket.sent).toHaveLength(1);
  });

  test('a fell-behind close resets the terminal before the replay; a gone session closes the tab', () => {
    const { log, sockets, clock, win } = connected();
    sockets.last().open();
    log.length = 0;
    sockets.last().serverClose(4003);
    expect(log.slice(0, 2)).toEqual(['term.reset', expect.stringMatching(/^term\.write/)]);
    sockets.last().serverClose(4001);
    clock.advance(2000);
    expect(win.calls).toEqual(['close']);
  });
});
