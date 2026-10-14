import { describe, expect, test } from 'bun:test';
import { pngSize, pngSizeFromBytes } from './png-size';

describe('pngSize', () => {
  test('reads width and height from the IHDR', () => {
    // 8-byte signature, 4-byte length, "IHDR", width=300, height=200
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
      0x01, 0x2c, 0, 0, 0, 0xc8,
    ]);
    expect(pngSize(btoa(String.fromCharCode(...bytes)))).toEqual({ width: 300, height: 200 });
  });

  test('not a PNG → null', () => {
    expect(pngSize(btoa('x'.repeat(24)))).toBeNull();
    expect(pngSize('AAAA')).toBeNull();
  });

  test('a payload that is not base64 → null', () => {
    expect(pngSize('!'.repeat(32))).toBeNull();
  });
});

describe('pngSizeFromBytes', () => {
  const header = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01,
    0x2c, 0, 0, 0, 0xc8,
  ]);

  test('reads the IHDR of a decoded file', () => {
    expect(pngSizeFromBytes(header)).toEqual({ width: 300, height: 200 });
  });

  test('rejects short or non-PNG data', () => {
    expect(pngSizeFromBytes(header.subarray(0, 10))).toBeNull();
    expect(pngSizeFromBytes(new Uint8Array(30))).toBeNull();
  });
});

describe('pngSizeFromBytes validation', () => {
  const valid = () =>
    new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
      0x01, 0x2c, 0, 0, 0, 0xc8,
    ]);

  test('a valid header is read', () => {
    expect(pngSizeFromBytes(valid())).toEqual({ width: 300, height: 200 });
  });

  test.each([
    ['first byte of the signature', (b: Uint8Array) => (b[0] = 0x00)],
    ['line-ending bytes of the signature', (b: Uint8Array) => (b[5] = 0x00)],
    ['IHDR length', (b: Uint8Array) => (b[11] = 12)],
    ['IHDR type', (b: Uint8Array) => (b[15] = 0x58)],
    ['zero width', (b: Uint8Array) => b.fill(0, 16, 20)],
    ['zero height', (b: Uint8Array) => b.fill(0, 20, 24)],
    ['width over 2^31 - 1', (b: Uint8Array) => b.fill(0xff, 16, 20)],
  ])('a wrong %s is refused', (_name, corrupt) => {
    const b = valid();
    corrupt(b);
    expect(pngSizeFromBytes(b)).toBeNull();
  });

  test('bytes that only spell PNG at offsets 1 to 3 are not a PNG', () => {
    const b = new Uint8Array(24);
    b.set([0x00, 0x50, 0x4e, 0x47], 0);
    expect(pngSizeFromBytes(b)).toBeNull();
  });

  test('the base64 form is validated the same way', () => {
    const b = valid();
    b[0] = 0x00;
    expect(pngSize(btoa(String.fromCharCode(...b)))).toBeNull();
  });
});
