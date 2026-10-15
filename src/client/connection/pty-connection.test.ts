import { describe, expect, test } from 'bun:test';
import { fakeWebSocket } from '../test-support/fake-socket';
import { ManualClock } from '../test-support/manual-clock';
import { CLOSE_WINDOW_MS, RETRY_MS } from './close-policy';
import { ACK_EVERY, ACK_IDLE_MS, OutputAck } from './output-ack';
import { PtyConnection, type PtyConnectionHost } from './pty-connection';
import { statusLine } from './status-line';

function setup(protocol = 'http:') {
  const clock = new ManualClock();
  const ws = fakeWebSocket();
  const calls: string[] = [];
  const size = { cols: 80, rows: 24 };
  const host: PtyConnectionHost = {
    size: () => ({ ...size }),
    created: () => calls.push(`created ${ws.sockets.length}`),
    opening: () => calls.push(`opening, sent ${ws.last().sent.length}`),
    opened: () => calls.push(`opened, sent ${ws.last().sent.length}`),
    output: (data, ack) => {
      calls.push(`output ${data}`);
      ack.parsed(data.length);
    },
    write: (data) => calls.push(`write ${data}`),
    reset: () => calls.push('reset'),
    closeWindow: () => calls.push('closeWindow'),
  };
  const connection = new PtyConnection('main', host, {
    WebSocket: ws.WebSocket,
    location: { protocol, host: 'localhost:2550' },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    createAck: (send) => new OutputAck(send, { set: clock.setTimeout, clear: clock.clearTimeout }),
  });
  return { clock, ws, calls, size, connection };
}

const resize = (cols: number, rows: number) => JSON.stringify({ type: 'resize', cols, rows });

describe('PtyConnection', () => {
  test('the URL carries the size and flow=1, over wss: on https', () => {
    const { ws, size, connection } = setup();
    size.cols = 120;
    size.rows = 40;
    connection.connect();
    expect(ws.last().url).toBe('ws://localhost:2550/ws/main/pty?cols=120&rows=40&flow=1');
    expect(setup('https:').connection.url()).toBe(
      'wss://localhost:2550/ws/main/pty?cols=80&rows=24&flow=1',
    );
  });

  test('created runs when the socket is made, before any message', () => {
    const { ws, calls, connection } = setup();
    connection.connect();
    expect(calls).toEqual(['created 1']);
    ws.last().open();
    ws.last().receive('x');
    expect(calls.at(-1)).toBe('output x');
  });

  test('on open: opening, then the size, then opened', () => {
    const { ws, calls, connection } = setup();
    connection.connect();
    ws.last().open();
    expect(calls).toEqual(['created 1', 'opening, sent 0', 'opened, sent 1']);
    expect(ws.last().sent).toEqual([resize(80, 24)]);
  });

  test('send and sendResize are dropped while the socket is not open', () => {
    const { ws, connection } = setup();
    connection.send('early');
    expect(connection.isOpen()).toBe(false);
    connection.connect();
    connection.send('connecting');
    connection.sendResize(1, 2);
    expect(connection.isOpen()).toBe(false);
    ws.last().open();
    expect(connection.isOpen()).toBe(true);
    connection.send('a');
    connection.sendResize(100, 30);
    ws.last().serverClose(1006);
    connection.send('closed');
    expect(connection.isOpen()).toBe(false);
    expect(ws.last().sent).toEqual([resize(80, 24), 'a', resize(100, 30)]);
  });

  test('a lost connection writes its status and reconnects after 2 s', () => {
    const { ws, calls, clock, connection } = setup();
    connection.connect();
    ws.last().open();
    calls.length = 0;
    ws.last().fail();
    expect(calls).toEqual([
      `write ${statusLine('WebSocket error.')}`,
      `write ${statusLine('Connection lost. Reconnecting in 2s...')}`,
    ]);
    clock.advance(RETRY_MS - 1);
    expect(ws.sockets.length).toBe(1);
    clock.advance(1);
    expect(ws.sockets.length).toBe(2);
    expect(calls.at(-1)).toBe('created 2');
  });

  test.each([
    [4001, 'Session removed.'],
    [1001, 'Server stopped.'],
  ])('close %d writes its status and closes the window after 500 ms', (code, message) => {
    const { ws, calls, clock, connection } = setup();
    connection.connect();
    ws.last().open();
    calls.length = 0;
    ws.last().serverClose(code);
    expect(calls).toEqual([`write ${statusLine(message)}`]);
    clock.advance(CLOSE_WINDOW_MS);
    expect(calls).toEqual([`write ${statusLine(message)}`, 'closeWindow']);
    expect(ws.sockets.length).toBe(1);
  });

  test('4003 resets, writes its status and reconnects at once', () => {
    const { ws, calls, connection } = setup();
    connection.connect();
    ws.last().open();
    calls.length = 0;
    ws.last().serverClose(4003);
    expect(calls).toEqual([
      'reset',
      `write ${statusLine('Tab fell behind; replaying recent output.')}`,
      'created 2',
    ]);
  });

  test("each socket's ack sends only on that socket", () => {
    const { ws, connection } = setup();
    connection.connect();
    const first = ws.last();
    first.open();
    first.receive('x'.repeat(ACK_EVERY));
    first.serverClose(4003);
    const second = ws.last();
    second.open();
    second.receive('y'.repeat(ACK_EVERY));
    const ack = (chars: number) => JSON.stringify({ type: 'ack', chars });
    expect(first.sent).toEqual([resize(80, 24), ack(ACK_EVERY)]);
    expect(second.sent).toEqual([resize(80, 24), ack(ACK_EVERY)]);
  });

  test('a queued ack is disposed on close and never reaches the next socket', () => {
    for (const code of [4003, 1006]) {
      const { ws, clock, connection } = setup();
      connection.connect();
      const first = ws.last();
      first.open();
      first.receive('queued');
      expect(clock.pending.timers).toBe(1);
      first.serverClose(code);
      clock.advance(RETRY_MS);
      const second = ws.last();
      expect(second).not.toBe(first);
      second.open();
      clock.advance(ACK_IDLE_MS * 2);
      expect(second.sent).toEqual([resize(80, 24)]);
      expect(first.sent).toEqual([resize(80, 24)]);
    }
  });

  test('the default ack is an OutputAck on the real timers', () => {
    const ws = fakeWebSocket();
    const noop = () => {};
    const connection = new PtyConnection(
      's',
      {
        size: () => ({ cols: 1, rows: 1 }),
        created: noop,
        opening: noop,
        opened: noop,
        output: (data, ack) => ack.parsed(data.length),
        write: noop,
        reset: noop,
        closeWindow: noop,
      },
      {
        WebSocket: ws.WebSocket,
        location: { protocol: 'http:', host: 'h' },
        setTimeout: () => 0,
        clearTimeout: noop,
      },
    );
    connection.connect();
    ws.last().open();
    ws.last().receive('z'.repeat(ACK_EVERY));
    expect(ws.last().sent.at(-1)).toBe(JSON.stringify({ type: 'ack', chars: ACK_EVERY }));
    connection.dispose();
  });

  test('dispose closes the socket, cancels a pending reconnect and is idempotent', () => {
    const { ws, calls, clock, connection } = setup();
    connection.connect();
    ws.last().open();
    ws.last().receive('pending ack');
    ws.last().serverClose(1006);
    expect(clock.pending.timers).toBe(1);
    connection.dispose();
    expect(clock.pending.timers).toBe(0);
    clock.advance(RETRY_MS);
    expect(ws.sockets.length).toBe(1);

    const open = setup();
    open.connection.connect();
    const socket = open.ws.last();
    socket.open();
    socket.receive('queued');
    open.calls.length = 0;
    open.connection.dispose();
    open.connection.dispose();
    expect(socket.closedBy).toEqual({ code: undefined, reason: undefined });
    expect(socket.onclose).toBeNull();
    expect(open.clock.pending.timers).toBe(0);
    expect(open.calls).toEqual([]);
    expect(open.connection.isOpen()).toBe(false);
    open.connection.connect();
    expect(open.ws.sockets.length).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
  });
});
