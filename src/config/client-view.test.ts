// Tests for the client-safe config view: the served keys, their order and the legacy
// `scrollback` key (ADR 062).
import { describe, expect, test } from 'bun:test';
import { toClientConfig } from './client-view';
import { CLIENT_CONFIG_KEYS } from './config-schema';
import { DEFAULT_CONFIG, DEFAULT_THEME } from './defaults';

describe('toClientConfig', () => {
  test('keeps exactly the client keys, in the order /api/config has always sent them', () => {
    expect(Object.keys(toClientConfig(DEFAULT_CONFIG))).toEqual([
      'cols',
      'rows',
      'fontSize',
      'fontFamily',
      'cursorStyle',
      'cursorStyleBlink',
      'scrollback',
      'scrollbackLines',
      'theme',
      'copyOnSelect',
      'rightClickBehavior',
      'clipboardWrite',
      'bellTitle',
      'desktopNotifications',
      'mouseScrollSpeed',
      'padding',
      'keyboardBindings',
    ]);
  });

  test('serialises DEFAULT_CONFIG to the pinned JSON', () => {
    expect(JSON.stringify(toClientConfig(DEFAULT_CONFIG))).toBe(
      JSON.stringify({
        cols: 80,
        rows: 24,
        fontSize: 13,
        fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'",
        cursorStyle: 'bar',
        cursorStyleBlink: true,
        scrollback: 262144,
        scrollbackLines: 10000,
        theme: DEFAULT_THEME,
        copyOnSelect: true,
        rightClickBehavior: 'contextMenu',
        clipboardWrite: true,
        bellTitle: true,
        desktopNotifications: true,
        mouseScrollSpeed: 1,
        padding: 0,
        keyboardBindings: [],
      }),
    );
  });

  test('never carries a server-only key', () => {
    const view = toClientConfig({ ...DEFAULT_CONFIG, env: { SECRET: 'x' }, logs: true });
    for (const key of ['port', 'host', 'shell', 'term', 'colorTerm', 'logs', 'env']) {
      expect(key in view).toBe(false);
    }
    expect(Object.keys(view)).toHaveLength(CLIENT_CONFIG_KEYS.length);
  });

  test('passes the configured values through unchanged', () => {
    const bindings = [{ key: 'enter', mods: ['shift'], chars: 'x' }];
    const view = toClientConfig({ ...DEFAULT_CONFIG, cols: 132, keyboardBindings: bindings });
    expect(view.cols).toBe(132);
    expect(view.keyboardBindings).toBe(bindings);
  });
});
