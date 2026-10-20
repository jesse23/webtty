// Tests for one Session over a fake PTY and fake sockets: output and scrollback, the PTY's
// start and exit, client attach and detach, close, events and the JSON view (ADR 062).
import { describe, expect, mock, test } from 'bun:test';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG } from '../../config';
import type { PtySpawnOptions } from '../../pty';
import { FakePty } from '../../test-support/fake-pty';
import { FakeSocket } from '../../test-support/fake-socket';
import { WS_CLOSE } from '../ws/close-codes';
import { type PtySpawnDeps, Session, type SessionExitHost, sessionToJson } from './session';
import { sessionBanner } from './session-banner';

/** Lets the pacer's end() promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A session wired to a FakePty, with every step it takes written to one log. */
function fixture(scrollback = DEFAULT_CONFIG.scrollback) {
  const log: string[] = [];
  const pty = new FakePty(log);
  const spawnPty = mock((options: PtySpawnOptions) => {
    const { cols, rows, ...rest } = options;
    log.push(`spawn ${cols}x${rows} ${JSON.stringify(rest)}`);
    return pty;
  });
  const deps: PtySpawnDeps = {
    loadConfig: () => ({ ...DEFAULT_CONFIG, scrollback, shell: '/bin/sh', env: { A: '1' } }),
    spawnPty,
    runner: 'bunx',
  };
  const host: SessionExitHost = {
    removeExited: (id) => log.push(`removeExited ${id}`),
    notifyIfEmpty: () => log.push('notifyIfEmpty'),
  };
  const session = new Session('s', '/work');
  return { log, pty, spawnPty, deps, host, session };
}

describe('new Session', () => {
  test('starts with no shell, no clients and no scrollback', () => {
    const session = new Session('test', '/tmp');
    expect(session.id).toBe('test');
    expect(session.baseDir).toBe('/tmp');
    expect(session.pty).toBeNull();
    expect(session.clients.size).toBe(0);
    expect(session.subscribers.size).toBe(0);
    expect(session.scrollback).toBe('');
    expect(typeof session.createdAt).toBe('number');
  });

  test('defaults baseDir to the home directory', () => {
    expect(new Session('test').baseDir).toBe(homedir());
  });
});

describe('session output', () => {
  test('pauses the PTY the session holds when its only client falls behind', () => {
    const session = new Session('test-output');
    const pause = mock(() => {});
    session.pty = { pid: 1, pause } as never;
    const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {}, close() {} };
    session.output.add(ws, true);
    session.output.broadcast('x'.repeat(2 * 1024 * 1024));
    expect(pause).toHaveBeenCalledTimes(1);
  });
});

describe('Session.ensurePty', () => {
  test('the first client spawns the shell with the config, then gets the banner, then the PTY a newline', () => {
    const { log, deps, host, session } = fixture();
    const ws = new FakeSocket(log);
    session.attach(ws, false);
    session.ensurePty(ws, 100, 30, deps, host);
    expect(log).toEqual([
      `spawn 100x30 ${JSON.stringify({ shell: '/bin/sh', term: DEFAULT_CONFIG.term, colorTerm: DEFAULT_CONFIG.colorTerm, cwd: '/work', env: { A: '1' } })}`,
      `ws.send ${JSON.stringify(sessionBanner('bunx').slice(0, 20))}`,
      'pty.write "\\n"',
    ]);
    expect(ws.sent).toEqual([sessionBanner('bunx')]);
    expect(session.scrollback).toBe(sessionBanner('bunx'));
  });

  test('a later client is sent the scrollback before the PTY is resized, and nothing is spawned', () => {
    const { log, deps, host, session, spawnPty, pty } = fixture();
    const first = new FakeSocket(log, 'first');
    session.attach(first, false);
    session.ensurePty(first, 80, 24, deps, host);
    pty.emitData('hello');
    log.length = 0;

    const second = new FakeSocket(log, 'second');
    session.attach(second, false);
    session.ensurePty(second, 120, 40, deps, host);
    expect(spawnPty).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      `second.send ${JSON.stringify(session.scrollback.slice(0, 20))}`,
      'pty.resize 120x40',
    ]);
    expect(second.sent).toEqual([`${sessionBanner('bunx')}hello`]);
  });

  test('a later client is put back in the input modes the trimmed scrollback no longer sets (ADR 070)', () => {
    const { deps, host, session, pty } = fixture(8);
    const first = new FakeSocket();
    session.attach(first, false);
    session.ensurePty(first, 80, 24, deps, host);
    pty.emitData('\x1b[?2004h\x1b[?1000;1006h');
    pty.emitData('0123456789');
    expect(session.scrollback).toBe('23456789');

    const second = new FakeSocket();
    session.attach(second, false);
    session.ensurePty(second, 80, 24, deps, host);
    expect(second.sent).toEqual(['\x1b[?1000;1006;2004h23456789']);
  });

  test('a later client with no scrollback is only resized', () => {
    const { log, deps, host, session } = fixture();
    session.pty = new FakePty(log);
    const ws = new FakeSocket(log);
    session.attach(ws, false);
    session.ensurePty(ws, 90, 20, deps, host);
    expect(log).toEqual(['pty.resize 90x20']);
  });

  test('output is broadcast to every client and kept in a ring of config.scrollback characters', () => {
    const { deps, host, session, pty } = fixture(8);
    const a = new FakeSocket();
    const b = new FakeSocket();
    session.attach(a, false);
    session.ensurePty(a, 80, 24, deps, host);
    session.attach(b, false);
    pty.emitData('0123456789');
    expect(session.scrollback).toBe('23456789');
    pty.emitData('ab');
    expect(session.scrollback).toBe('456789ab');
    expect(a.sent.slice(1)).toEqual(['0123456789', 'ab']);
    expect(b.sent).toEqual(['0123456789', 'ab']);
  });

  test('the config is read when the shell spawns, not before', () => {
    const { deps, host, session } = fixture();
    const loadConfig = mock(deps.loadConfig);
    const ws = new FakeSocket();
    session.attach(ws, false);
    expect(loadConfig).not.toHaveBeenCalled();
    session.ensurePty(ws, 80, 24, { ...deps, loadConfig }, host);
    expect(loadConfig).toHaveBeenCalledTimes(1);
  });
});

describe('Session exit', () => {
  test('unregisters, closes open subscribers, clears the PTY, closes clients, then reports empty', async () => {
    const { log, deps, host, session, pty } = fixture();
    const ws = new FakeSocket(log, 'client');
    const sub = new FakeSocket(log, 'sub');
    const closedSub = new FakeSocket(log, 'gone');
    closedSub.readyState = 3;
    session.attach(ws, true);
    session.ensurePty(ws, 80, 24, deps, host);
    session.subscribers.add(sub);
    session.subscribers.add(closedSub);
    log.length = 0;

    pty.emitExit();
    expect(session.pty).toBeNull();
    expect(session.subscribers.size).toBe(0);
    expect(sub.closed).toEqual({ code: WS_CLOSE.SESSION_GONE, reason: 'shell exited' });
    expect(closedSub.closed).toBeNull();
    expect(log).toEqual([
      'removeExited s',
      `sub.close ${WS_CLOSE.SESSION_GONE}`,
      `client.close ${WS_CLOSE.SESSION_GONE}`,
    ]);
    await settle();
    expect(log.at(-1)).toBe('notifyIfEmpty');
  });

  test('a client behind the output is flushed before it is closed and before onEmpty', async () => {
    const { log, deps, host, session, pty } = fixture();
    const ws = new FakeSocket(log, 'client');
    session.attach(ws, true);
    session.ensurePty(ws, 80, 24, deps, host);
    const big = 'x'.repeat(2 * 1024 * 1024);
    pty.emitData(big);
    pty.emitData('tail');
    pty.emitExit();
    await settle();
    expect(log).not.toContain('notifyIfEmpty');
    expect(ws.closed).toBeNull();

    session.output.ack(ws, sessionBanner('bunx').length + big.length);
    expect(ws.sent.at(-1)).toBe('tail');
    expect(ws.closed).toEqual({ code: WS_CLOSE.SESSION_GONE, reason: 'shell exited' });
    await settle();
    expect(log.indexOf('removeExited s')).toBeLessThan(
      log.indexOf(`client.close ${WS_CLOSE.SESSION_GONE}`),
    );
    expect(log.at(-1)).toBe('notifyIfEmpty');
  });
});

describe('Session.attach and detach', () => {
  test('detach removes the client from the set and the pacer', () => {
    const session = new Session('s');
    const ws = new FakeSocket();
    session.attach(ws, false);
    expect(session.clients.has(ws)).toBe(true);
    session.detach(ws);
    expect(session.clients.size).toBe(0);
    session.output.broadcast('after');
    expect(ws.sent).toEqual([]);
  });
});

describe('Session.close', () => {
  test('kills the shell and closes every client and subscriber with the code', () => {
    const log: string[] = [];
    const session = new Session('s');
    session.pty = new FakePty(log);
    session.clients.add(new FakeSocket(log, 'client'));
    session.subscribers.add(new FakeSocket(log, 'sub'));
    session.close(WS_CLOSE.SERVER_STOPPED, 'server stopped');
    expect(log).toEqual(['pty.kill', 'client.close 1001', 'sub.close 1001']);
    expect(session.subscribers.size).toBe(0);
  });

  test('a session without a shell just closes its sockets', () => {
    const session = new Session('s');
    const ws = new FakeSocket();
    session.clients.add(ws);
    session.close(WS_CLOSE.SESSION_GONE, 'session deleted');
    expect(ws.closed).toEqual({ code: 4001, reason: 'session deleted' });
  });
});

describe('Session.broadcastEvent', () => {
  test('sends the line to open subscribers only', () => {
    const session = new Session('s');
    const open = new FakeSocket();
    const closed = new FakeSocket();
    closed.readyState = 3;
    session.subscribers.add(open);
    session.subscribers.add(closed);
    session.broadcastEvent('{"a":1}');
    expect(open.sent).toEqual(['{"a":1}']);
    expect(closed.sent).toEqual([]);
  });
});

describe('sessionToJson', () => {
  test('connected is false when no clients', () => {
    expect(sessionToJson(new Session('test')).connected).toBe(false);
  });

  test('connected is true when clients set is non-empty', () => {
    const session = new Session('test');
    session.clients.add(new FakeSocket());
    expect(sessionToJson(session).connected).toBe(true);
  });

  test('includes id, createdAt and baseDir', () => {
    const json = sessionToJson(new Session('test', '/tmp'));
    expect(json.id).toBe('test');
    expect(json.baseDir).toBe('/tmp');
    expect(typeof json.createdAt).toBe('number');
  });

  test('pid is null when pty is not yet spawned', () => {
    expect(sessionToJson(new Session('test-pid-null')).pid).toBeNull();
  });

  test('pid reflects pty pid when pty is set', () => {
    const session = new Session('test-pid-set');
    session.pty = new FakePty([], 12345);
    expect(sessionToJson(session).pid).toBe(12345);
  });
});
