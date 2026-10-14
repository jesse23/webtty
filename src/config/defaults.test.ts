import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG, DEFAULT_KEYBOARD_BINDINGS, DEFAULT_THEME, defaultShell } from './defaults';

describe('defaultShell', () => {
  test.each([
    ['win32', { COMSPEC: 'C:\\pwsh.exe' }, 'C:\\pwsh.exe'],
    ['win32', {}, 'cmd.exe'],
    ['darwin', { SHELL: '/bin/zsh', COMSPEC: 'x' }, '/bin/zsh'],
    ['linux', {}, '/bin/bash'],
  ])('%s with %p → %p', (platform, env, expected) => {
    expect(defaultShell(platform, env)).toBe(expected);
  });

  test('reads the live process by default', () => {
    expect(defaultShell()).toBe(defaultShell(process.platform, process.env));
  });
});

describe('DEFAULT_CONFIG', () => {
  test('term is xterm-256color', () => {
    expect(DEFAULT_CONFIG.term).toBe('xterm-256color');
  });

  test('fontFamily ends with STIX Two Text for enclosing marks', () => {
    expect(DEFAULT_CONFIG.fontFamily).toBe(
      "Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'",
    );
  });

  test('uses the default theme and bindings', () => {
    expect(DEFAULT_CONFIG.theme).toBe(DEFAULT_THEME);
    expect(DEFAULT_CONFIG.keyboardBindings).toBe(DEFAULT_KEYBOARD_BINDINGS);
    expect(DEFAULT_KEYBOARD_BINDINGS).toEqual([]);
  });

  test('pins the scalar defaults', () => {
    const { shell: _shell, theme: _theme, keyboardBindings: _kb, ...rest } = DEFAULT_CONFIG;
    expect(rest).toEqual({
      port: 2346,
      host: '127.0.0.1',
      term: 'xterm-256color',
      colorTerm: 'truecolor',
      scrollback: 262144,
      scrollbackLines: 10000,
      cols: 80,
      rows: 24,
      fontSize: 13,
      fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'",
      cursorStyle: 'bar',
      cursorStyleBlink: true,
      copyOnSelect: true,
      rightClickBehavior: 'contextMenu',
      clipboardWrite: true,
      bellTitle: true,
      desktopNotifications: true,
      mouseScrollSpeed: 1,
      padding: 0,
      logs: false,
      env: {},
    });
  });
});
