import { describe, expect, test } from 'bun:test';
import type { KeyEncoder } from '../../ghostty-web/engine/engine-types';
import {
  encodeKeyPress,
  encoderText,
  isPrintableKey,
  type KeyEventFields,
  keyForCode,
  keyMods,
  plainKeySequence,
} from '../../ghostty-web/input/key-encoding';
import { KEY_MAP } from '../../ghostty-web/input/key-map';
import {
  Key,
  KeyAction,
  KeyEncoderOption,
  type KeyEvent,
  Mods,
} from '../../ghostty-web/input/key-types';
import { loadGhostty } from '../support/wasm';

// The DOM key to bytes path of the InputHandler (ADR 047, ADR 061).

const NO_MODS = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

/** A key event with only the named modifiers held. */
function keyEvent(key: string, ...mods: (keyof typeof NO_MODS)[]): KeyEventFields {
  const held = Object.fromEntries(mods.map((mod) => [mod, true]));
  return { key, code: '', ...NO_MODS, ...held };
}

/** A key encoder that records what it is given and answers with fixed bytes. */
class RecordingEncoder implements KeyEncoder {
  readonly options: [KeyEncoderOption, boolean | number][] = [];
  readonly events: KeyEvent[] = [];
  constructor(private readonly reply: Uint8Array) {}
  setOption(option: KeyEncoderOption, value: boolean | number): void {
    this.options.push([option, value]);
  }
  encode(event: KeyEvent): Uint8Array {
    this.events.push(event);
    return this.reply;
  }
  dispose(): void {}
}

describe('keyForCode', () => {
  test.each([
    ['KeyA', Key.A],
    ['Digit0', Key.ZERO],
    ['Enter', Key.ENTER],
    ['Backquote', Key.GRAVE],
    ['ArrowLeft', Key.LEFT],
    ['NumpadEnter', Key.KP_ENTER],
    ['IntlBackslash', Key.INTL_BACKSLASH],
    ['F24', Key.F24],
  ])('%s is %p', (code, key) => {
    expect(keyForCode(code)).toBe(key);
  });

  test('a code the table does not know is null', () => {
    expect(keyForCode('')).toBeNull();
    expect(keyForCode('Fn')).toBeNull();
    expect(keyForCode('MediaPlayPause')).toBeNull();
  });

  test('every entry maps to a distinct key', () => {
    const keys = Object.values(KEY_MAP);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('keyMods', () => {
  test.each([
    [[], Mods.NONE],
    [['shiftKey'], Mods.SHIFT],
    [['ctrlKey'], Mods.CTRL],
    [['altKey'], Mods.ALT],
    [['metaKey'], Mods.SUPER],
    [['shiftKey', 'ctrlKey', 'altKey', 'metaKey'], Mods.SHIFT | Mods.CTRL | Mods.ALT | Mods.SUPER],
  ] as [(keyof typeof NO_MODS)[], Mods][])('%p is %p', (mods, expected) => {
    expect(keyMods(keyEvent('a', ...mods))).toBe(expected);
  });
});

describe('isPrintableKey', () => {
  test.each([
    ['a', [], true],
    ['A', ['shiftKey'], true],
    ['€', ['ctrlKey', 'altKey'], true], // AltGr
    ['a', ['ctrlKey'], false],
    ['a', ['altKey'], false],
    ['a', ['metaKey'], false],
    ['a', ['ctrlKey', 'altKey', 'metaKey'], false],
    ['Enter', [], false],
    ['ArrowUp', ['shiftKey'], false],
  ] as [string, (keyof typeof NO_MODS)[], boolean][])('%p with %p is %p', (key, mods, expected) => {
    expect(isPrintableKey(keyEvent(key, ...mods))).toBe(expected);
  });
});

describe('plainKeySequence', () => {
  test('sends CR and ESC for Shift+Enter and Shift+Escape, as xterm does', () => {
    expect(plainKeySequence(Key.ENTER, Mods.SHIFT)).toBe('\r');
    expect(plainKeySequence(Key.ESCAPE, Mods.SHIFT)).toBe('\x1b');
  });

  test('leaves every other key to the encoder', () => {
    for (const key of [Key.ENTER, Key.ESCAPE, Key.TAB, Key.BACKSPACE, Key.HOME, Key.F1]) {
      expect(plainKeySequence(key, Mods.NONE)).toBeNull();
      expect(plainKeySequence(key, Mods.CTRL)).toBeNull();
    }
    for (const key of [Key.TAB, Key.BACKSPACE, Key.HOME, Key.END, Key.PAGE_UP, Key.F5]) {
      expect(plainKeySequence(key, Mods.SHIFT)).toBeNull();
    }
  });
});

describe('encoderText', () => {
  test.each([
    ['a', 'a'],
    ['A', 'a'],
    ['1', '1'],
    ['~', '~'],
    ['é', undefined],
    ['Enter', undefined],
    ['', undefined],
  ])('%p gives %p', (key, expected) => {
    expect(encoderText(key)).toBe(expected);
  });
});

describe('encodeKeyPress', () => {
  test('encodes a press with the base character and decodes the bytes', () => {
    const encoder = new RecordingEncoder(new TextEncoder().encode('\x01'));
    expect(encodeKeyPress(encoder, Key.A, Mods.CTRL, 'A', undefined)).toBe('\x01');
    expect(encoder.events).toEqual([
      { action: KeyAction.PRESS, key: Key.A, mods: Mods.CTRL, utf8: 'a' },
    ]);
    // No mode callback: the cursor key option is left as it is
    expect(encoder.options).toEqual([]);
  });

  test('sets the cursor key mode from DECCKM before encoding', () => {
    const encoder = new RecordingEncoder(new Uint8Array());
    expect(encodeKeyPress(encoder, Key.UP, Mods.NONE, 'ArrowUp', true)).toBe('');
    encodeKeyPress(encoder, Key.UP, Mods.NONE, 'ArrowUp', false);
    expect(encoder.options).toEqual([
      [KeyEncoderOption.CURSOR_KEY_APPLICATION, true],
      [KeyEncoderOption.CURSOR_KEY_APPLICATION, false],
    ]);
    expect(encoder.events[0].utf8).toBeUndefined();
  });

  test('the official encoder gives the xterm bytes', async () => {
    const encoder = (await loadGhostty()).createKeyEncoder();
    expect(encodeKeyPress(encoder, Key.UP, Mods.NONE, 'ArrowUp', false)).toBe('\x1b[A');
    expect(encodeKeyPress(encoder, Key.UP, Mods.NONE, 'ArrowUp', true)).toBe('\x1bOA');
    expect(encodeKeyPress(encoder, Key.C, Mods.CTRL, 'c', false)).toBe('\x03');
    encoder.dispose();
  });
});
