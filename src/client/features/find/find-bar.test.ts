import { describe, expect, test } from 'bun:test';
import { countDescription, countLabel, fieldKey } from './find-bar';

describe('countLabel', () => {
  test("shows Ghostty's selected/total, 0 before a match is selected", () => {
    expect(countLabel({ total: 0, selected: null })).toBe('0/0');
    expect(countLabel({ total: 12, selected: null })).toBe('0/12');
    expect(countLabel({ total: 12, selected: 0 })).toBe('1/12');
    expect(countLabel({ total: 12, selected: 11 })).toBe('12/12');
  });
});

describe('countDescription', () => {
  test('says the count in words for a screen reader', () => {
    expect(countDescription({ total: 0, selected: null })).toBe('No matches');
    expect(countDescription({ total: 1, selected: null })).toBe('1 match');
    expect(countDescription({ total: 3, selected: null })).toBe('3 matches');
    expect(countDescription({ total: 3, selected: 1 })).toBe('Match 2 of 3');
  });
});

describe('fieldKey', () => {
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
      expect(fieldKey(key('Enter', 'Enter'), mac)).toBe('next');
      expect(fieldKey(key('Enter', 'NumpadEnter'), mac)).toBe('next');
      expect(fieldKey(key('Enter', 'Enter', ['shift']), mac)).toBe('previous');
      expect(fieldKey(key('Enter', 'Enter', ['ctrl']), mac)).toBeNull();
    }
  });

  test('Escape closes', () => {
    expect(fieldKey(key('Escape', 'Escape'), false)).toBe('close');
    expect(fieldKey(key('Escape', 'Escape'), true)).toBe('close');
  });

  test('the find shortcuts work in the field: Cmd+G, Cmd+Shift+F, and the open key selects', () => {
    expect(fieldKey(key('g', 'KeyG', ['meta']), true)).toBe('next');
    expect(fieldKey(key('G', 'KeyG', ['meta', 'shift']), true)).toBe('previous');
    expect(fieldKey(key('F', 'KeyF', ['meta', 'shift']), true)).toBe('close');
    expect(fieldKey(key('f', 'KeyF', ['meta']), true)).toBe('select');
    expect(fieldKey(key('F', 'KeyF', ['ctrl', 'shift']), false)).toBe('select');
  });

  test('other keys are the field’s: typing, copy, paste, clear', () => {
    expect(fieldKey(key('a', 'KeyA'), false)).toBeNull();
    expect(fieldKey(key('v', 'KeyV', ['ctrl']), false)).toBeNull();
    expect(fieldKey(key('k', 'KeyK', ['meta']), true)).toBeNull();
    expect(fieldKey(key('C', 'KeyC', ['ctrl', 'shift']), false)).toBeNull();
  });
});
