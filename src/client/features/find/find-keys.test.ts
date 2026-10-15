import { describe, expect, test } from 'bun:test';
import { shortcutFor } from '../keyboard/shortcut-map';
import { type FieldKeyEvent, fieldKey } from './find-keys';

describe('fieldKey', () => {
  // The lookup the root passes in (ADR 060). A test may import across features; the
  // module itself only sees the lookup.
  const lookup = (mac: boolean) => (e: FieldKeyEvent) => shortcutFor(e, mac)?.action;
  const key = (k: string, code: string, mods: string[] = []) => ({
    key: k,
    code,
    ctrlKey: mods.includes('ctrl'),
    shiftKey: mods.includes('shift'),
    altKey: mods.includes('alt'),
    metaKey: mods.includes('meta'),
  });

  test('Enter goes to the next match (older), Shift+Enter to the previous', () => {
    for (const mac of [false, true]) {
      expect(fieldKey(key('Enter', 'Enter'), lookup(mac))).toBe('next');
      expect(fieldKey(key('Enter', 'NumpadEnter'), lookup(mac))).toBe('next');
      expect(fieldKey(key('Enter', 'Enter', ['shift']), lookup(mac))).toBe('previous');
      expect(fieldKey(key('Enter', 'Enter', ['ctrl']), lookup(mac))).toBeNull();
    }
  });

  test('Escape closes', () => {
    expect(fieldKey(key('Escape', 'Escape'), lookup(false))).toBe('close');
    expect(fieldKey(key('Escape', 'Escape'), lookup(true))).toBe('close');
  });

  test('the find shortcuts work in the field: Cmd+G, Cmd+Shift+F, and the open key selects', () => {
    expect(fieldKey(key('g', 'KeyG', ['meta']), lookup(true))).toBe('next');
    expect(fieldKey(key('G', 'KeyG', ['meta', 'shift']), lookup(true))).toBe('previous');
    expect(fieldKey(key('F', 'KeyF', ['meta', 'shift']), lookup(true))).toBe('close');
    expect(fieldKey(key('f', 'KeyF', ['meta']), lookup(true))).toBe('select');
    expect(fieldKey(key('F', 'KeyF', ['ctrl', 'shift']), lookup(false))).toBe('select');
  });

  test('Enter is the field’s own key: the lookup is not asked', () => {
    let asked = 0;
    const counting = (e: FieldKeyEvent) => {
      asked++;
      return shortcutFor(e, true)?.action;
    };
    expect(fieldKey(key('Enter', 'Enter'), counting)).toBe('next');
    expect(asked).toBe(0);
    expect(fieldKey(key('Escape', 'Escape'), counting)).toBe('close');
    expect(asked).toBe(1);
  });

  test('other keys are the field’s: typing, copy, paste, clear', () => {
    expect(fieldKey(key('a', 'KeyA'), lookup(false))).toBeNull();
    expect(fieldKey(key('v', 'KeyV', ['ctrl']), lookup(false))).toBeNull();
    expect(fieldKey(key('k', 'KeyK', ['meta']), lookup(true))).toBeNull();
    expect(fieldKey(key('C', 'KeyC', ['ctrl', 'shift']), lookup(false))).toBeNull();
  });
});
