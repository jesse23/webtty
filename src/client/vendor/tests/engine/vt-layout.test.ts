import { describe, expect, test } from 'bun:test';
import {
  type ManifestType,
  readBits,
  readVtLayout,
  VtLayout,
} from '../../ghostty-web/engine/vt-layout';

// The manifest reader (ADR 041) on a hand-written manifest, without the wasm.

const MANIFEST: Record<string, ManifestType> = {
  GhosttyPoint: {
    kind: 'struct',
    size: 16,
    fields: { tag: { offset: 0, size: 4 }, value: { offset: 8, size: 8 } },
  },
  GhosttyPointTag: { kind: 'enum', size: 4, values: { ACTIVE: 0, SCREEN: 2 } },
  GhosttyCell: {
    kind: 'packed',
    size: 8,
    bits: {
      content_tag: { lsb: 0, width: 2 },
      wide: { lsb: 62, width: 2 },
      whole: { lsb: 0, width: 32 },
      content: {
        lsb: 2,
        width: 24,
        arms: {
          CODEPOINT: { bits: { codepoint: { lsb: 0, width: 21 } } },
          NONE: null,
        },
      },
    },
  },
};

const layout = new VtLayout(MANIFEST);

describe('readBits', () => {
  test.each([
    { name: 'low word, at bit 0', lo: 0xabcd, hi: 0, lsb: 0, mask: 0xff, bits: 0xcd },
    { name: 'low word, shifted', lo: 0xabcd, hi: 0, lsb: 8, mask: 0xff, bits: 0xab },
    { name: 'high word', lo: 0, hi: 0b1100, lsb: 34, mask: 0b11, bits: 0b11 },
    { name: 'across the words', lo: 0xf0000000, hi: 0x3, lsb: 28, mask: 0x3f, bits: 0x3f },
    { name: 'a full low word', lo: 0xffffffff, hi: 0, lsb: 0, mask: 0xffffffff, bits: 0xffffffff },
  ])('$name', ({ lo, hi, lsb, mask, bits }) => {
    expect(readBits(lo, hi, lsb, mask) >>> 0).toBe(bits);
  });
});

describe('VtLayout', () => {
  test('reads sizes, offsets and enum values', () => {
    expect(layout.size('GhosttyPoint')).toBe(16);
    expect(layout.offset('GhosttyPoint', 'value')).toBe(8);
    expect(layout.enums('GhosttyPointTag')).toEqual({ ACTIVE: 0, SCREEN: 2 });
    expect(layout.value('GhosttyPointTag', 'SCREEN')).toBe(2);
  });

  test('turns a bit width into a mask, a 32-bit field into all ones', () => {
    const bits = layout.type('GhosttyCell').bits;
    expect(layout.bitField(bits, 'content_tag')).toEqual({ lsb: 0, mask: 0b11 });
    expect(layout.bitField(bits, 'wide')).toEqual({ lsb: 62, mask: 0b11 });
    expect(layout.bitField(bits, 'whole')).toEqual({ lsb: 0, mask: 0xffffffff });
  });

  test('reads the bits of one arm of a packed union field', () => {
    const arm = layout.armBits('GhosttyCell', 'content', 'CODEPOINT');
    expect(layout.bitField(arm, 'codepoint')).toEqual({ lsb: 0, mask: 0x1fffff });
  });

  test.each([
    ['a type', () => layout.type('GhosttyNope'), 'no type GhosttyNope'],
    ['a field', () => layout.offset('GhosttyPoint', 'nope'), 'no field GhosttyPoint.nope'],
    ['an enum', () => layout.enums('GhosttyPoint'), 'GhosttyPoint is not an enum'],
    ['a value', () => layout.value('GhosttyPointTag', 'NOPE'), 'no value GhosttyPointTag.NOPE'],
    ['a bit field', () => layout.bitField(undefined, 'wide'), 'no bit field wide'],
    [
      'an arm',
      () => layout.armBits('GhosttyCell', 'content', 'NONE'),
      'no arm GhosttyCell.content.NONE',
    ],
  ])('a missing %s throws with its name', (_what, read, message) => {
    expect(read).toThrow(message);
  });
});

describe('readVtLayout', () => {
  test('decodes the NUL-terminated manifest at the address ghostty_type_json returns', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const json = new TextEncoder().encode(JSON.stringify({ types: MANIFEST }));
    const at = 100;
    new Uint8Array(memory.buffer).set(json, at);
    const read = readVtLayout({ memory, ghostty_type_json: () => at });
    expect(read.value('GhosttyPointTag', 'SCREEN')).toBe(2);
    expect(read.offset('GhosttyPoint', 'value')).toBe(8);
  });
});
