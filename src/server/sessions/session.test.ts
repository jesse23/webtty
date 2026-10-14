import { describe, expect, mock, test } from 'bun:test';
import { homedir } from 'node:os';
import { newSession, sessionToJson } from './session';

describe('newSession', () => {
  test('returns session with correct shape', () => {
    const session = newSession('test', '/tmp');
    expect(session.id).toBe('test');
    expect(session.baseDir).toBe('/tmp');
    expect(session.pty).toBeNull();
    expect(session.clients.size).toBe(0);
    expect(session.subscribers.size).toBe(0);
    expect(session.scrollback).toBe('');
    expect(typeof session.createdAt).toBe('number');
  });

  test('defaults baseDir to the home directory', () => {
    expect(newSession('test').baseDir).toBe(homedir());
  });
});

describe('session output', () => {
  test('pauses the PTY the session holds when its only client falls behind', () => {
    const session = newSession('test-output');
    const pause = mock(() => {});
    session.pty = { pid: 1, pause } as never;
    const ws = { readyState: 1, OPEN: 1, bufferedAmount: 0, send() {}, close() {} };
    session.output.add(ws, true);
    session.output.broadcast('x'.repeat(2 * 1024 * 1024));
    expect(pause).toHaveBeenCalledTimes(1);
  });
});

describe('sessionToJson', () => {
  test('connected is false when no clients', () => {
    const session = newSession('test');
    expect(sessionToJson(session).connected).toBe(false);
  });

  test('connected is true when clients set is non-empty', () => {
    const session = newSession('test');
    session.clients.add({} as never);
    expect(sessionToJson(session).connected).toBe(true);
  });

  test('includes id, createdAt and baseDir', () => {
    const session = newSession('test', '/tmp');
    const json = sessionToJson(session);
    expect(json.id).toBe('test');
    expect(json.baseDir).toBe('/tmp');
    expect(typeof json.createdAt).toBe('number');
  });

  test('pid is null when pty is not yet spawned', () => {
    const session = newSession('test-pid-null');
    expect(sessionToJson(session).pid).toBeNull();
  });

  test('pid reflects pty pid when pty is set', () => {
    const session = newSession('test-pid-set');
    session.pty = { pid: 12345 } as never;
    expect(sessionToJson(session).pid).toBe(12345);
  });
});
