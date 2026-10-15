// Table tests for session IDs: the accepted format and the random default (ADR 062).
import { describe, expect, test } from 'bun:test';
import { generateId, isValidId } from './session-id';

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
