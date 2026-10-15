import { describe, expect, test } from 'bun:test';
import {
  OFFICIAL_ENCODER_OPTION_NAMES,
  OFFICIAL_KEY_NAMES,
  translateEnum,
} from '../../ghostty-web/engine/key-tables';
import { VtLayout } from '../../ghostty-web/engine/vt-layout';
import { Key, KeyEncoderOption } from '../../ghostty-web/input/key-types';

// The by-name translation of ghostty-web's enums to libghostty-vt's (ADR 042), without the wasm.

enum Ours {
  A = 0,
  B = 1,
  OLD_NAME = 2,
}

const layout = new VtLayout({
  Official: { kind: 'enum', size: 4, values: { A: 10, B: 11, NEW_NAME: 12, EXTRA: 13 } },
});

describe('translateEnum', () => {
  test('maps each numeric value to the official value of the same or renamed name', () => {
    const map = translateEnum(Ours, layout, 'Official', { OLD_NAME: 'NEW_NAME' });
    expect([...map]).toEqual([
      [0, 10],
      [1, 11],
      [2, 12],
    ]);
  });

  test('a name the official enum lacks throws', () => {
    expect(() => translateEnum(Ours, layout, 'Official', {})).toThrow('no value Official.OLD_NAME');
  });
});

describe('the rename tables', () => {
  test('rename only names the ghostty-web enums have', () => {
    for (const name of Object.keys(OFFICIAL_KEY_NAMES)) expect(name in Key).toBe(true);
    for (const name of Object.keys(OFFICIAL_ENCODER_OPTION_NAMES)) {
      expect(name in KeyEncoderOption).toBe(true);
    }
  });
});
