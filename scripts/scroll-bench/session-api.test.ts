import { describe, expect, test } from 'bun:test';
import { benchSessionId } from './session-api';

describe('benchSessionId', () => {
  test('a slug of the parts and the time, valid as a session ID', () => {
    const id = benchSessionId(['after', 'claude-classic', 'wheel', 2], 36 ** 3);
    expect(id).toBe('bench-after-claude-classic-wheel-2-1000');
    expect(id).toMatch(/^[a-z0-9\-_.]{1,64}$/);
  });

  test('folds labels that are not ID characters and stays short', () => {
    const id = benchSessionId(['localhost:3001', 'X'.repeat(80)], 0);
    expect(id.startsWith('bench-localhost-3001-x')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
  });
});
