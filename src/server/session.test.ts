import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createSession,
  generateId,
  isValidId,
  lastUsedId,
  sessionRegistry,
  sessionToJson,
  setLastUsedId,
} from './session';

beforeEach(() => {
  sessionRegistry.clear();
});

describe('isValidId', () => {
  test('accepts lowercase letters, digits, hyphen, underscore, dot', () => {
    expect(isValidId('abc')).toBe(true);
    expect(isValidId('my-session')).toBe(true);
    expect(isValidId('my_session')).toBe(true);
    expect(isValidId('my.session')).toBe(true);
    expect(isValidId('abc123')).toBe(true);
  });

  test('rejects uppercase letters', () => {
    expect(isValidId('ABC')).toBe(false);
    expect(isValidId('MySession')).toBe(false);
  });

  test('rejects spaces and special characters', () => {
    expect(isValidId('my session')).toBe(false);
    expect(isValidId('my/session')).toBe(false);
    expect(isValidId('my@session')).toBe(false);
    expect(isValidId('INVALID ID!')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidId('')).toBe(false);
  });

  test('rejects id longer than 64 characters', () => {
    expect(isValidId('a'.repeat(65))).toBe(false);
    expect(isValidId('a'.repeat(64))).toBe(true);
  });
});

describe('generateId', () => {
  test('returns 8-character lowercase hex string', () => {
    const id = generateId();
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });

  test('returns different values on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, generateId));
    expect(ids.size).toBeGreaterThan(1);
  });
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
