import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../../config';
import { FakePty } from '../../test-support/fake-pty';
import { FakeSocket } from '../../test-support/fake-socket';
import type { PtySpawnDeps } from '../sessions/session';
import { sessionBanner } from '../sessions/session-banner';
import { SessionStore } from '../sessions/session-store';
import { WS_CLOSE } from './close-codes';
import { handlePtySocket } from './pty-socket';

/** A store with session `s`, spawn deps that hand out one FakePty, and a shared log. */
function fixture() {
  const log: string[] = [];
  const pty = new FakePty(log);
  const store = new SessionStore();
  const session = store.create('s', '/work');
  const deps: PtySpawnDeps = {
    loadConfig: () => DEFAULT_CONFIG,
    spawnPty: ({ cols, rows }) => {
      log.push(`spawn ${cols}x${rows}`);
      return pty;
    },
    runner: 'npx',
  };
  return { log, pty, store, session, deps };
}

const query = (q: string) => new URLSearchParams(q);

describe('handlePtySocket attach', () => {
  test('an unknown session closes the socket with SESSION_GONE and registers nothing', () => {
    const { store, deps } = fixture();
    const ws = new FakeSocket();
    handlePtySocket(store, ws, 'nope', query(''), deps);
    expect(ws.closed).toEqual({ code: WS_CLOSE.SESSION_GONE, reason: 'session deleted' });
    expect(ws.listenerCount('message')).toBe(0);
    expect(store.lastUsedId).toBeNull();
  });

  test('the first client spawns at the query size: banner, then scrollback is the banner, then a newline', () => {
    const { log, store, session, deps } = fixture();
    const ws = new FakeSocket(log);
    handlePtySocket(store, ws, 's', query('cols=100&rows=30&flow=1'), deps);
    expect(log).toEqual([
      'spawn 100x30',
      `ws.send ${JSON.stringify(sessionBanner('npx').slice(0, 20))}`,
      'pty.write "\\n"',
    ]);
    expect(session.clients.has(ws)).toBe(true);
    expect(session.scrollback).toBe(sessionBanner('npx'));
    expect(store.lastUsedId).toBe('s');
  });

  test('a client without a size spawns the shell at 80x24, and an absurd size is clamped', () => {
    const one = fixture();
    handlePtySocket(one.store, new FakeSocket(), 's', query(''), one.deps);
    expect(one.log[0]).toBe('spawn 80x24');
    const two = fixture();
    handlePtySocket(two.store, new FakeSocket(), 's', query('cols=99999&rows=0'), two.deps);
    expect(two.log[0]).toBe('spawn 1000x24');
  });

  test('a reconnecting client gets the scrollback replay before the resize', () => {
    const { log, pty, store, deps } = fixture();
    handlePtySocket(store, new FakeSocket(log, 'first'), 's', query(''), deps);
    pty.emitData('$ ls\r\n');
    log.length = 0;
    const second = new FakeSocket(log, 'second');
    handlePtySocket(store, second, 's', query('cols=90&rows=20'), deps);
    expect(log).toEqual([
      `second.send ${JSON.stringify(sessionBanner('npx').slice(0, 20))}`,
      'pty.resize 90x20',
    ]);
    expect(second.sent.join('')).toBe(`${sessionBanner('npx')}$ ls\r\n`);
  });
});

describe('handlePtySocket messages', () => {
  function attached(flow = '1') {
    const f = fixture();
    const ws = new FakeSocket(f.log);
    handlePtySocket(f.store, ws, 's', query(`flow=${flow}`), f.deps);
    f.log.length = 0;
    return { ...f, ws };
  }

  test('raw input is written to the PTY as is', () => {
    const { log, ws } = attached();
    ws.receive('ls\r');
    ws.receive('{not json');
    expect(log).toEqual(['pty.write "ls\\r"', 'pty.write "{not json"']);
  });

  test('a resize message resizes the PTY, clamped, and is not written', () => {
    const { log, ws } = attached();
    ws.receive('{"type":"resize","cols":120,"rows":9999}');
    expect(log).toEqual(['pty.resize 120x500']);
  });

  test('an ack message goes to the pacer and is not written', () => {
    const { log, ws, pty, session } = attached();
    const big = 'x'.repeat(2 * 1024 * 1024);
    pty.emitData(big);
    pty.emitData('queued');
    expect(ws.sent.at(-1)).toBe(big);
    ws.receive(`{"type":"ack","chars":${sessionBanner('npx').length + big.length}}`);
    expect(ws.sent.at(-1)).toBe('queued');
    expect(log.filter((l) => l.startsWith('pty.write'))).toEqual([]);
    expect(session.output.isPaused).toBe(false);
  });

  test('a resize the PTY refuses is written to it as raw input instead', () => {
    const { log, ws, pty } = attached();
    pty.resize = () => {
      throw new Error('exited');
    };
    ws.receive('{"type":"resize","cols":10,"rows":10}');
    expect(log).toEqual(['pty.write "{\\"type\\":\\"resize\\",\\"cols\\":10,\\"rows\\":10}"']);
  });

  test('messages after the shell exited are dropped', () => {
    const { log, ws, session } = attached();
    session.pty = null;
    ws.receive('ls\r');
    ws.receive('{"type":"resize","cols":10,"rows":10}');
    expect(log).toEqual([]);
  });

  test('close detaches the client from the session and the pacer; error is ignored', () => {
    const { ws, pty, session } = attached('0');
    ws.emit('error', new Error('reset'));
    ws.emit('close');
    expect(session.clients.size).toBe(0);
    pty.emitData('later');
    expect(ws.sent.at(-1)).not.toBe('later');
  });
});
