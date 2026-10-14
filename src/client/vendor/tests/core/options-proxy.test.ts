import { describe, expect, test } from 'bun:test';
import {
  createOptionsProxy,
  parseThemeColor,
  TERMINAL_DEFAULTS,
  toEngineConfig,
  withDefaults,
} from '../../ghostty-web/core/options-proxy';
import type { ITerminalOptions } from '../../ghostty-web/interfaces';

// Terminal's options: the defaults, the runtime-change proxy and the engine config.

describe('withDefaults', () => {
  test('fills every option not given with its default, the engine dropped', () => {
    const options = withDefaults({ ghostty: {} as never });
    expect(options).toEqual({ ...TERMINAL_DEFAULTS, theme: {}, scrollbackLines: undefined });
    expect('ghostty' in options).toBe(false);
  });

  test('keeps the options given, falsy ones included', () => {
    const theme = { background: '#000000' };
    expect(
      withDefaults({
        ghostty: {} as never,
        cols: 100,
        cursorStyle: 'bar',
        theme,
        scrollbackLines: 0,
        copyOnSelect: false,
        mouseScrollSpeed: 0,
        rightClickBehavior: 'paste',
      }),
    ).toMatchObject({
      cols: 100,
      rows: 24,
      cursorStyle: 'bar',
      theme,
      scrollbackLines: 0,
      copyOnSelect: false,
      mouseScrollSpeed: 0,
      rightClickBehavior: 'paste',
    });
  });

  test('gives each terminal its own theme object', () => {
    expect(withDefaults({ ghostty: {} as never }).theme).not.toBe(
      withDefaults({ ghostty: {} as never }).theme,
    );
  });

  test('lists the keys in the order Terminal has always kept them', () => {
    expect(Object.keys(withDefaults({ ghostty: {} as never }))).toEqual([
      'cols',
      'rows',
      'cursorBlink',
      'cursorStyle',
      'theme',
      'scrollbackLines',
      'fontSize',
      'fontFamily',
      'allowTransparency',
      'convertEol',
      'disableStdin',
      'mouseScrollSpeed',
      'copyOnSelect',
      'rightClickBehavior',
      'clipboardWrite',
      'desktopNotifications',
    ]);
  });
});

describe('createOptionsProxy', () => {
  test('stores each assignment, then reports it with the value it replaced', () => {
    const changes: unknown[] = [];
    const values = { fontSize: 15, fontFamily: 'monospace' };
    const options = createOptionsProxy(values, (key, value, old) => {
      // The new value is already stored when the change is reported
      changes.push([key, value, old, options[key]]);
    });
    options.fontSize = 18;
    options.fontSize = 18;
    expect(changes).toEqual([
      ['fontSize', 18, 15, 18],
      ['fontSize', 18, 18, 18],
    ]);
    expect(values.fontSize).toBe(18);
  });

  test('reads go straight to the values', () => {
    const values = { cols: 80 };
    const options = createOptionsProxy(values, () => {});
    values.cols = 120;
    expect(options.cols).toBe(120);
  });
});

describe('parseThemeColor', () => {
  test.each([
    ['#d4d4d4', 0xd4d4d4],
    ['#000000', 0],
    ['#fff', 0xffffff],
    ['#0a1', 0x00aa11],
    ['rgb(1, 2, 3)', 0x010203],
    ['rgb(255,0,128)', 0xff0080],
    ['#zzzzzz', undefined],
    ['red', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%p is %p', (color, expected) => {
    expect(parseThemeColor(color)).toBe(expected);
  });
});

describe('toEngineConfig', () => {
  const config = (options: Partial<ITerminalOptions>) =>
    toEngineConfig(withDefaults({ ghostty: {} as never, ...options }));

  test('passes scrollbackLines through to the engine, unset when not given (ADR 046)', () => {
    expect(config({ scrollbackLines: 10000 }).scrollbackLines).toBe(10000);
    expect(config({ scrollbackLines: 0 }).scrollbackLines).toBe(0);
    expect(config({ theme: {} }).scrollbackLines).toBeUndefined();
  });

  test('leaves unset and invalid colours undefined, so #000000 is black (ADR 042)', () => {
    const engine = config({
      theme: { foreground: '#d4d4d4', background: '#000000', red: 'nope', green: '#0dbc79' },
    });
    expect(engine).toMatchObject({ fgColor: 0xd4d4d4, bgColor: 0, cursorColor: undefined });
    expect(engine.palette?.slice(0, 3)).toEqual([undefined, undefined, 0x0dbc79]);
  });

  test('puts the 16 ANSI colours in palette order, the bright ones last', () => {
    const engine = config({
      theme: { black: '#000001', white: '#000008', brightWhite: '#000010' },
    });
    expect(engine.palette).toHaveLength(16);
    expect([engine.palette?.[0], engine.palette?.[7], engine.palette?.[15]]).toEqual([1, 8, 16]);
  });

  test('passes cursorStyle and cursorBlink as the engine default cursor (ADR 049)', () => {
    expect(config({ cursorStyle: 'bar', cursorBlink: true })).toMatchObject({
      cursorStyle: 'bar',
      cursorBlink: true,
    });
    expect(config({})).toMatchObject({ cursorStyle: 'block', cursorBlink: false });
  });

  test('passes clipboardWrite and desktopNotifications, on by default (ADR 052, ADR 056)', () => {
    expect(config({})).toMatchObject({ clipboardWrite: true, desktopNotifications: true });
    expect(config({ clipboardWrite: false, desktopNotifications: false })).toMatchObject({
      clipboardWrite: false,
      desktopNotifications: false,
    });
  });
});
