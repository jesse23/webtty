import { beforeAll, describe, expect, test } from 'bun:test';
import type { Ghostty } from '../../ghostty-web/ghostty';
import { Key, KeyAction, KeyEncoderOption, Mods } from '../../ghostty-web/input/key-types';
import { loadGhostty } from '../support/wasm';

// The wasm key encoder (ADR 042, ADR 061), made by the Ghostty factory.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

describe('official engine: key encoder', () => {
  test('encodes keys by their official names', () => {
    const enc = vt.createKeyEncoder();
    const encode = (key: Key, mods = Mods.NONE, utf8?: string) =>
      new TextDecoder().decode(enc.encode({ action: KeyAction.PRESS, key, mods, utf8 }));
    expect(encode(Key.UP)).toBe('\x1b[A');
    expect(encode(Key.ENTER)).toBe('\r');
    expect(encode(Key.C, Mods.CTRL, 'c')).toBe('\x03');
    expect(encode(Key.ONE, Mods.NONE, '1')).toBe('1');
    expect(encode(Key.GRAVE, Mods.NONE, '`')).toBe('`');
    expect(encode(Key.F1)).toBe('\x1bOP');
    expect(encode(Key.PASTE)).toBe('');
    enc.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, true);
    expect(encode(Key.UP)).toBe('\x1bOA');
    enc.dispose();
  });
});
