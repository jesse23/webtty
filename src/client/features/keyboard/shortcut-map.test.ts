import { describe, expect, test } from 'bun:test';
import { isMacPlatform, type Shortcut, shortcutFor } from './shortcut-map';

type Mod = 'ctrl' | 'shift' | 'alt' | 'meta';
const key = (code: string, mods: Mod[] = []) => ({
  code,
  ctrlKey: mods.includes('ctrl'),
  shiftKey: mods.includes('shift'),
  altKey: mods.includes('alt'),
  metaKey: mods.includes('meta'),
});

describe('isMacPlatform', () => {
  test('macOS and iOS take the macOS defaults', () => {
    expect(isMacPlatform('macOS')).toBe(true);
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('iPhone')).toBe(true);
    expect(isMacPlatform('iPad')).toBe(true);
  });

  test('Windows, Linux and ChromeOS do not', () => {
    expect(isMacPlatform('Windows')).toBe(false);
    expect(isMacPlatform('Win32')).toBe(false);
    expect(isMacPlatform('Linux x86_64')).toBe(false);
    expect(isMacPlatform('Chrome OS')).toBe(false);
    expect(isMacPlatform('')).toBe(false);
  });
});

describe('shortcutFor outside macOS', () => {
  const at = (code: string, mods: Mod[] = []) => shortcutFor(key(code, mods), false);

  test('Ctrl+Shift+C copies, and goes to the app with no selection', () => {
    expect(at('KeyC', ['ctrl', 'shift'])).toEqual({ action: 'copy', performable: true });
  });

  test('Ctrl+C stays the interrupt', () => {
    expect(at('KeyC', ['ctrl'])).toBeNull();
  });

  test('Ctrl+Insert copies and Shift+Insert pastes, consumed either way', () => {
    expect(at('Insert', ['ctrl'])).toEqual({ action: 'copy', performable: false });
    expect(at('Insert', ['shift'])).toEqual({ action: 'paste', performable: false });
    expect(at('Insert')).toBeNull();
  });

  test('Ctrl+V and Ctrl+Shift+V paste', () => {
    expect(at('KeyV', ['ctrl'])?.action).toBe('paste');
    expect(at('KeyV', ['ctrl', 'shift'])?.action).toBe('paste');
  });

  test('modifiers match exactly', () => {
    expect(at('KeyC', ['ctrl', 'shift', 'alt'])).toBeNull();
    expect(at('KeyC', ['ctrl', 'shift', 'meta'])).toBeNull();
    expect(at('Insert', ['ctrl', 'shift'])).toBeNull();
  });

  test('Cmd+K is not clear', () => {
    expect(at('KeyK', ['meta'])).toBeNull();
  });
});

describe('shortcutFor on macOS', () => {
  const at = (code: string, mods: Mod[] = []) => shortcutFor(key(code, mods), true);

  test('Cmd+K clears, and goes to the app on the alternate screen', () => {
    expect(at('KeyK', ['meta'])).toEqual({ action: 'clear', performable: true });
    expect(at('KeyK', ['meta', 'shift'])).toBeNull();
    expect(at('KeyK', ['ctrl'])).toBeNull();
  });

  test('Ctrl+Shift+C and the Insert keys go to the app', () => {
    expect(at('KeyC', ['ctrl', 'shift'])).toBeNull();
    expect(at('Insert', ['ctrl'])).toBeNull();
    expect(at('Insert', ['shift'])).toBeNull();
  });

  test('Ctrl+V pastes, with Shift or Alt too; Cmd+V and Cmd+C are left to the browser path', () => {
    expect(at('KeyV', ['ctrl'])?.action).toBe('paste');
    expect(at('KeyV', ['ctrl', 'shift'])?.action).toBe('paste');
    expect(at('KeyV', ['ctrl', 'alt'])?.action).toBe('paste');
    expect(at('KeyV', ['meta'])).toBeNull();
    expect(at('KeyV', ['ctrl', 'meta'])).toBeNull();
    expect(at('KeyC', ['meta'])).toBeNull();
  });
});

describe('shortcutFor find keys (ADR 055)', () => {
  const at = (mac: boolean, code: string, mods: Mod[] = []) => shortcutFor(key(code, mods), mac);

  test('Ctrl+Shift+F opens the find bar outside macOS, Cmd+F on macOS', () => {
    expect(at(false, 'KeyF', ['ctrl', 'shift'])).toEqual({ action: 'find', performable: false });
    expect(at(true, 'KeyF', ['meta'])).toEqual({ action: 'find', performable: false });
    expect(at(true, 'KeyF', ['ctrl', 'shift'])).toBeNull();
    expect(at(false, 'KeyF', ['meta'])).toBeNull();
  });

  test('Ctrl+F stays the app’s', () => {
    expect(at(false, 'KeyF', ['ctrl'])).toBeNull();
    expect(at(true, 'KeyF', ['ctrl'])).toBeNull();
  });

  test('Escape closes, and goes to the app with no search open', () => {
    for (const mac of [false, true]) {
      expect(at(mac, 'Escape')).toEqual({ action: 'findClose', performable: true });
      expect(at(mac, 'Escape', ['shift'])).toBeNull();
    }
  });

  test('Cmd+Shift+F closes and Cmd+G / Cmd+Shift+G move on macOS only', () => {
    expect(at(true, 'KeyF', ['meta', 'shift'])).toEqual({ action: 'findClose', performable: true });
    expect(at(true, 'KeyG', ['meta'])).toEqual({ action: 'findNext', performable: true });
    expect(at(true, 'KeyG', ['meta', 'shift'])).toEqual({
      action: 'findPrevious',
      performable: true,
    });
    expect(at(false, 'KeyG', ['meta'])).toBeNull();
    expect(at(false, 'KeyG', ['ctrl'])).toBeNull();
  });
});

describe('shortcutFor jump-to-prompt keys (ADR 057)', () => {
  const at = (mac: boolean, code: string, mods: Mod[] = []) => shortcutFor(key(code, mods), mac);
  const previous: Shortcut = { action: 'promptPrevious', performable: false };
  const next: Shortcut = { action: 'promptNext', performable: false };

  test('Ctrl+Shift+Up / Down outside macOS, consumed with or without a prompt', () => {
    expect(at(false, 'ArrowUp', ['ctrl', 'shift'])).toEqual(previous);
    expect(at(false, 'ArrowDown', ['ctrl', 'shift'])).toEqual(next);
    expect(at(false, 'ArrowUp', ['ctrl'])).toBeNull();
    expect(at(false, 'ArrowUp', ['meta'])).toBeNull();
  });

  test('Cmd+Up / Down and Cmd+Shift+Up / Down on macOS', () => {
    expect(at(true, 'ArrowUp', ['meta'])).toEqual(previous);
    expect(at(true, 'ArrowUp', ['meta', 'shift'])).toEqual(previous);
    expect(at(true, 'ArrowDown', ['meta'])).toEqual(next);
    expect(at(true, 'ArrowDown', ['meta', 'shift'])).toEqual(next);
    expect(at(true, 'ArrowUp', ['ctrl', 'shift'])).toBeNull();
    expect(at(true, 'ArrowUp', ['meta', 'alt'])).toBeNull();
  });
});
