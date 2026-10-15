import { describe, expect, test } from 'bun:test';
import { num, parseKittyApc } from './apc-command';

describe('parseKittyApc', () => {
  test('parses keys and payload', () => {
    expect(parseKittyApc('Ga=T,f=32,s=2,v=1,i=7;AAAA')).toEqual({
      keys: { a: 'T', f: '32', s: '2', v: '1', i: '7' },
      payload: 'AAAA',
    });
  });

  test('no payload', () => {
    expect(parseKittyApc('Ga=d,d=A')).toEqual({ keys: { a: 'd', d: 'A' }, payload: '' });
  });

  test('payload may itself contain no semicolons beyond the first', () => {
    expect(parseKittyApc('Gi=1;a;b')?.payload).toBe('a;b');
  });

  test('non-graphics APC returns null', () => {
    expect(parseKittyApc('Xhello')).toBeNull();
  });
});

describe('num', () => {
  test.each([
    ['a number', { s: '42' }, 42],
    ['absent', {}, 7],
    ['not a number', { s: 'x' }, 7],
    ['not finite', { s: 'Infinity' }, 7],
  ])('%s', (_name, keys, expected) => {
    expect(num(keys as Record<string, string>, 's', 7)).toBe(expected);
  });

  test('the fallback defaults to 0', () => {
    expect(num({}, 's')).toBe(0);
  });
});
