import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  createSession,
  lastUsedId,
  sessionRegistry,
  sessionToJson,
  setLastUsedId,
} from './session';

beforeEach(() => {
  sessionRegistry.clear();
});

describe('createSession', () => {
  test('adds session to registry', () => {
    createSession('test');
    expect(sessionRegistry.has('test')).toBe(true);
  });

  test('returns session with correct shape', () => {
    const session = createSession('test');
    expect(session.id).toBe('test');
    expect(session.pty).toBeNull();
    expect(session.clients.size).toBe(0);
    expect(session.scrollback).toBe('');
    expect(typeof session.createdAt).toBe('number');
  });
});

describe('session output', () => {
  test('pauses the PTY the session holds when its only client falls behind', () => {
    const session = createSession('test-output');
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
    const session = createSession('test');
    expect(sessionToJson(session).connected).toBe(false);
  });

  test('connected is true when clients set is non-empty', () => {
    const session = createSession('test');
    session.clients.add({} as never);
    expect(sessionToJson(session).connected).toBe(true);
  });

  test('includes id and createdAt', () => {
    const session = createSession('test');
    const json = sessionToJson(session);
    expect(json.id).toBe('test');
    expect(typeof json.createdAt).toBe('number');
  });

  test('pid is null when pty is not yet spawned', () => {
    const session = createSession('test-pid-null');
    expect(sessionToJson(session).pid).toBeNull();
  });

  test('pid reflects pty pid when pty is set', () => {
    const session = createSession('test-pid-set');
    session.pty = { pid: 12345 } as never;
    expect(sessionToJson(session).pid).toBe(12345);
  });
});

describe('setLastUsedId', () => {
  test('updates lastUsedId to the given value', () => {
    setLastUsedId('my-session');
    expect(lastUsedId).toBe('my-session');
  });

  test('accepts null to clear lastUsedId', () => {
    setLastUsedId('my-session');
    setLastUsedId(null);
    expect(lastUsedId).toBeNull();
  });
});
