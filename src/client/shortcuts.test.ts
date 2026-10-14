import { describe, expect, test } from 'bun:test';
import { isMacPlatform, shortcutFor } from './shortcuts';

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
