import { describe, expect, test } from 'bun:test';
import { isValidBinding, mergeKeyboardBindings, normalizeBinding } from './keyboard-bindings';

describe('isValidBinding', () => {
  test.each([
    ['key and chars', { key: 'a', chars: 'x' }, true],
    ['key, chars and mods', { key: 'a', chars: 'x', mods: ['ctrl'] }, true],
    ['an empty mods array', { key: 'a', chars: 'x', mods: [] }, true],
    ['null', null, false],
    ['a string', 'a', false],
    ['no key', { chars: 'x' }, false],
    ['no chars', { key: 'a' }, false],
    ['a numeric key', { key: 1, chars: 'x' }, false],
    ['object mods', { key: 'a', chars: 'x', mods: {} }, false],
    ['string mods', { key: 'a', chars: 'x', mods: 'ctrl' }, false],
  ])('%s → %p', (_label, value, expected) => {
    expect(isValidBinding(value)).toBe(expected);
  });
});

describe('normalizeBinding', () => {
  test.each([
    [
      { key: 'Enter', chars: 'x' },
      { key: 'enter', chars: 'x', mods: [] },
    ],
    [
      { key: 'A', chars: 'x', mods: ['CTRL', 'Shift'] },
      { key: 'a', chars: 'x', mods: ['ctrl', 'shift'] },
    ],
    [
      { key: 'tab', chars: 'x', mods: ['alt', 'meta', 'super', 'hyper'] },
      { key: 'tab', chars: 'x', mods: ['alt', 'meta'] },
    ],
  ])('%p → %p', (input, expected) => {
    expect(normalizeBinding(input)).toEqual(expected);
  });
});

describe('mergeKeyboardBindings', () => {
  const base = { key: 'enter', mods: ['shift'], chars: '\u001b[13;2u' };

  test('user entry replaces matching default by key+mods identity', () => {
    const result = mergeKeyboardBindings([base], [{ ...base, chars: 'custom' }]);
    expect(result).toHaveLength(1);
    expect(result[0].chars).toBe('custom');
  });

  test('user entry for different mods is added alongside default', () => {
    const user = { key: 'enter', mods: ['ctrl'], chars: '\u001b[13;5u' };
    const result = mergeKeyboardBindings([base], [user]);
    expect(result).toEqual([base, user]);
  });

  test('default is preserved when user has no matching entry', () => {
    const result = mergeKeyboardBindings([base], []);
    expect(result).toEqual([base]);
  });

  test('mods order and key case are irrelevant for identity', () => {
    const defaults = [{ key: 'Enter', mods: ['shift', 'ctrl'], chars: 'default' }];
    const user = { key: 'enter', mods: ['ctrl', 'shift'], chars: 'replaced' };
    expect(mergeKeyboardBindings(defaults, [user])).toEqual([user]);
  });

  test('a binding without mods matches one with an empty mods list', () => {
    const user = { key: 'enter', chars: 'replaced' };
    expect(mergeKeyboardBindings([{ key: 'enter', mods: [], chars: 'd' }], [user])).toEqual([user]);
  });

  test('of duplicate user entries the last one wins', () => {
    const result = mergeKeyboardBindings(
      [],
      [
        { key: 'a', chars: 'first' },
        { key: 'a', chars: 'last' },
      ],
    );
    expect(result).toEqual([{ key: 'a', chars: 'last' }]);
  });
});
