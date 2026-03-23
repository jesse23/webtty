import { beforeEach, describe, expect, test } from 'bun:test';
import { createSession, generateId, isValidId, sessionRegistry, sessionToJson } from './session';

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
});
