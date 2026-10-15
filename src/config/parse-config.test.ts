// Table tests for the pure config parser: one rule per key, the whole object, keyboard bindings
// and the right-click behaviour (ADR 062).
import { describe, expect, test } from 'bun:test';
import type { Config } from './config-schema';
import { DEFAULT_CONFIG, DEFAULT_KEYBOARD_BINDINGS, DEFAULT_THEME } from './defaults';
import { parseConfig, parseRightClickBehavior } from './parse-config';

const D = DEFAULT_CONFIG;

/** One row per rule: the value the file sets for `key`, and what parseConfig makes of it. */
type Row = [key: keyof Config, value: unknown, expected: unknown];

// Valid values pass through, wrong types and out-of-range values fall back to the default.
const ROWS: Row[] = [
  ['port', 9999, 9999],
  ['port', 'not-a-number', D.port],
  ['host', '0.0.0.0', '0.0.0.0'],
  ['host', 42, D.host],
  ['shell', '/bin/zsh', '/bin/zsh'],
  ['shell', 1, D.shell],
  ['term', 'xterm', 'xterm'],
  ['term', false, D.term],
  ['colorTerm', '24bit', '24bit'],
  ['colorTerm', 1, D.colorTerm],
  ['scrollback', 1024, 1024],
  ['scrollback', '1024', D.scrollback],
  ['scrollbackLines', 0, 0],
  ['scrollbackLines', 2500.7, 2500],
  ['scrollbackLines', -1, 10000],
  ['scrollbackLines', Number.POSITIVE_INFINITY, 10000],
  ['scrollbackLines', Number.NaN, 10000],
  ['scrollbackLines', '5000', 10000],
  ['scrollbackLines', null, 10000],
  ['cols', 120, 120],
  ['cols', true, D.cols],
  ['rows', 40, 40],
  ['rows', '40', D.rows],
  ['fontSize', 18, 18],
  ['fontSize', '18', D.fontSize],
  ['fontFamily', 'Menlo', 'Menlo'],
  ['fontFamily', 1, D.fontFamily],
  ['cursorStyle', 'block', 'block'],
  ['cursorStyle', 'bar', 'bar'],
  ['cursorStyle', 'underline', 'underline'],
  ['cursorStyle', 'bogus', D.cursorStyle],
  ['cursorStyle', 1, D.cursorStyle],
  ['cursorStyleBlink', false, false],
  ['cursorStyleBlink', 'false', D.cursorStyleBlink],
  ['copyOnSelect', false, false],
  ['copyOnSelect', 0, D.copyOnSelect],
  ['rightClickBehavior', 'copyPaste', 'copyPaste'],
  ['rightClickBehavior', 'paste', 'paste'],
  ['rightClickBehavior', 'none', 'none'],
  ['rightClickBehavior', 'contextMenu', 'contextMenu'],
  ['rightClickBehavior', 'default', 'contextMenu'],
  ['rightClickBehavior', 'bogus', 'contextMenu'],
  ['rightClickBehavior', 3, 'contextMenu'],
  ['clipboardWrite', false, false],
  ['clipboardWrite', 'false', true],
  ['clipboardWrite', 0, true],
  ['clipboardWrite', null, true],
  ['bellTitle', false, false],
  ['bellTitle', 'false', true],
  ['bellTitle', 0, true],
  ['bellTitle', null, true],
  ['desktopNotifications', false, false],
  ['desktopNotifications', 'false', true],
  ['desktopNotifications', 0, true],
  ['desktopNotifications', null, true],
  ['mouseScrollSpeed', 2.5, 2.5],
  ['mouseScrollSpeed', 0, D.mouseScrollSpeed],
  ['mouseScrollSpeed', -1, D.mouseScrollSpeed],
  ['mouseScrollSpeed', '2', D.mouseScrollSpeed],
  ['padding', 8, 8],
  ['padding', 6.9, 6],
  ['padding', 0, 0],
  ['padding', -4, 0],
  ['padding', Number.POSITIVE_INFINITY, 0],
  ['padding', '8', 0],
  ['logs', true, true],
  ['logs', 'true', D.logs],
  ['theme', { background: '#101010' }, { ...DEFAULT_THEME, background: '#101010' }],
  ['theme', { padding: '#0D0D0D' }, { ...DEFAULT_THEME, padding: '#0D0D0D' }],
  ['theme', null, DEFAULT_THEME],
  ['theme', 'dark', DEFAULT_THEME],
  ['keyboardBindings', 'invalid', DEFAULT_KEYBOARD_BINDINGS],
  ['env', { FOO: 'bar', NUM: 2, NIL: null }, { FOO: 'bar' }],
  ['env', ['FOO=bar'], {}],
  ['env', 'FOO=bar', {}],
  ['env', null, {}],
];

describe('parseConfig — one rule per key', () => {
  test.each(ROWS)('%s = %p gives %p', (key, value, expected) => {
    const actual: unknown = parseConfig({ [key]: value })[key];
    expect(actual).toEqual(expected);
  });

  test('every Config key has at least one row', () => {
    const covered = new Set(ROWS.map(([key]) => key));
    expect(Object.keys(DEFAULT_CONFIG).filter((k) => !covered.has(k as keyof Config))).toEqual([]);
  });
});

describe('parseConfig — the whole object', () => {
  test('an empty file gives DEFAULT_CONFIG', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("keeps DEFAULT_CONFIG's key order whatever order the file uses", () => {
    expect(Object.keys(parseConfig({ env: {}, port: 1, cols: 100 }))).toEqual(
      Object.keys(DEFAULT_CONFIG),
    );
  });

  test('ignores unknown keys', () => {
    const config = parseConfig({ unknownKey: 'value', port: 1234 });
    expect(config.port).toBe(1234);
    expect('unknownKey' in config).toBe(false);
  });

  test('null is not a config object and throws, as loadConfig always has', () => {
    expect(() => parseConfig(null)).toThrow(TypeError);
  });
});

describe('parseConfig — keyboardBindings', () => {
  test('a user binding is used as-is when no defaults exist', () => {
    const bindings = parseConfig({
      keyboardBindings: [{ key: 'enter', mods: ['shift'], chars: 'custom' }],
    }).keyboardBindings;
    expect(bindings).toEqual([{ key: 'enter', mods: ['shift'], chars: 'custom' }]);
  });

  test('several user bindings are all kept', () => {
    const bindings = parseConfig({
      keyboardBindings: [
        { key: 'enter', mods: ['ctrl'], chars: '\u001b[13;5u' },
        { key: 'tab', mods: ['shift'], chars: '\u001b[9;2u' },
      ],
    }).keyboardBindings;
    expect(bindings.map((b) => b.key)).toEqual(['enter', 'tab']);
  });

  test('mods order does not affect identity, and the last entry wins', () => {
    const bindings = parseConfig({
      keyboardBindings: [
        { key: 'enter', mods: ['ctrl', 'shift'], chars: 'first' },
        { key: 'enter', mods: ['shift', 'ctrl'], chars: 'last-wins' },
      ],
    }).keyboardBindings;
    expect(bindings).toHaveLength(1);
    expect(bindings[0].chars).toBe('last-wins');
  });

  test('entries missing key or chars, or with non-array mods, are dropped', () => {
    const bindings = parseConfig({
      keyboardBindings: [{ mods: ['shift'] }, { key: 'enter' }, { key: 'a', chars: 'x', mods: {} }],
    }).keyboardBindings;
    expect(bindings).toEqual([]);
  });

  test('keys and mods are lower-cased and unknown mods are dropped', () => {
    const bindings = parseConfig({
      keyboardBindings: [{ key: 'Enter', mods: ['SHIFT', 'super', 'unknown'], chars: 'x' }],
    }).keyboardBindings;
    expect(bindings).toEqual([{ key: 'enter', mods: ['shift'], chars: 'x' }]);
  });
});

describe('parseRightClickBehavior', () => {
  test.each([
    ['contextMenu', 'contextMenu'],
    ['copyPaste', 'copyPaste'],
    ['paste', 'paste'],
    ['none', 'none'],
    ['default', 'contextMenu'],
    ['webtty', 'contextMenu'],
    ['Paste', 'contextMenu'],
    ['', 'contextMenu'],
  ])('%p gives %p', (value, expected) => {
    expect(parseRightClickBehavior(value)).toBe(
      expected as ReturnType<typeof parseRightClickBehavior>,
    );
  });
});
