import { describe, expect, test } from 'bun:test';
import type { Ghostty } from '../vendor/ghostty-web';
import type { ClientConfig } from './client-config';
import { toTerminalOptions } from './terminal-options';

const config: ClientConfig = {
  cols: 100,
  rows: 30,
  fontSize: 14,
  fontFamily: 'Menlo',
  cursorStyle: 'bar',
  cursorStyleBlink: true,
  scrollback: 256 * 1024,
  scrollbackLines: 5000,
  theme: { background: '#000000', padding: '#111111' },
  copyOnSelect: false,
  rightClickBehavior: 'paste',
  clipboardWrite: false,
  bellTitle: true,
  desktopNotifications: false,
  mouseScrollSpeed: 2,
  padding: 8,
  keyboardBindings: [{ key: 'enter', mods: ['shift'], chars: '\n' }],
};

describe('toTerminalOptions', () => {
  test('maps the config onto the Terminal options (snapshot)', () => {
    // The engine is passed through untouched; a tagged object stands in for it.
    const ghostty = { engine: 'test' } as unknown as Ghostty;
    const theme = { background: '#000000' };
    const options = toTerminalOptions(config, theme, ghostty);
    const { ghostty: engine, theme: terminalTheme, ...rest } = options;
    expect(engine).toBe(ghostty);
    expect(terminalTheme).toBe(theme);
    expect(rest).toEqual({
      cols: 100,
      rows: 30,
      cursorStyle: 'bar',
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo',
      scrollbackLines: 5000,
      mouseScrollSpeed: 2,
      copyOnSelect: false,
      rightClickBehavior: 'paste',
      clipboardWrite: false,
      desktopNotifications: false,
    });
  });
});
