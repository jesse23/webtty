import { describe, expect, test } from 'bun:test';
import type { KeyboardBinding } from '../../app/client-config';
import { type BindingKeyEvent, findBinding } from './key-bindings';

/** A keydown with no modifiers unless given. */
function key(k: string, mods: Partial<BindingKeyEvent> = {}): BindingKeyEvent {
  return { key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods };
}

const ctrlK: KeyboardBinding = { key: 'k', mods: ['ctrl'], chars: '\x0b' };
const shiftEnter: KeyboardBinding = { key: 'Enter', mods: ['Shift'], chars: '\x1b\r' };
const allMods: KeyboardBinding = { key: 'x', mods: ['meta', 'alt', 'ctrl', 'shift'], chars: 'x' };
const bare: KeyboardBinding = { key: 'F1', mods: [], chars: '' };
const noMods = { key: 'F2', chars: 'f2' } as KeyboardBinding;
const bindings = [ctrlK, shiftEnter, allMods, bare, noMods];

describe('findBinding', () => {
  test.each([
    ['exact modifiers', key('k', { ctrlKey: true }), ctrlK],
    ['an upper-case key', key('K', { ctrlKey: true }), ctrlK],
    ['upper-case modifiers in the config', key('enter', { shiftKey: true }), shiftEnter],
    [
      'every modifier, in any order',
      key('x', { shiftKey: true, ctrlKey: true, altKey: true, metaKey: true }),
      allMods,
    ],
    ['an empty binding (it claims the key)', key('F1'), bare],
    ['a binding without mods', key('F2'), noMods],
  ])('matches %s', (_name, e, expected) => {
    expect(findBinding(e, bindings)).toBe(expected);
  });

  test.each([
    ['an extra modifier', key('k', { ctrlKey: true, shiftKey: true })],
    ['a missing modifier', key('k')],
    ['a different modifier', key('k', { altKey: true })],
    ['another key', key('j', { ctrlKey: true })],
    ['one modifier short of all', key('x', { shiftKey: true, ctrlKey: true, altKey: true })],
  ])('does not match %s', (_name, e) => {
    expect(findBinding(e, bindings)).toBeUndefined();
  });

  test('the first matching binding wins', () => {
    const second: KeyboardBinding = { ...ctrlK, chars: 'second' };
    expect(findBinding(key('k', { ctrlKey: true }), [ctrlK, second])).toBe(ctrlK);
  });

  test('no bindings, no match', () => {
    expect(findBinding(key('k', { ctrlKey: true }), [])).toBeUndefined();
  });
});
