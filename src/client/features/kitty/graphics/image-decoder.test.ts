import { afterEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  assertSupported,
  assertWithinLimits,
  BROWSER_DECODER,
  decodeFootprint,
  decodeImage,
  transmissionSize,
} from './image-decoder';
import { KittyError } from './kitty-error';
import { b64, FakeDecoder, fakeBitmap, pngHeader, zeros } from './test-support/graphics-harness';

const keysOf = (s: string): Record<string, string> =>
  Object.fromEntries(s.split(',').map((kv) => kv.split('=') as [string, string]));

/** The code and message a call is refused with, or null when it passes. */
function refusal(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (e) {
    return e instanceof KittyError ? `${e.code}:${e.message}` : String(e);
  }
}

describe('assertSupported', () => {
  test.each([
    ['f=32', null],
    ['f=24,t=d', null],
    ['f=100', null],
    ['t=f', 'EINVAL:unsupported transmission medium t=f'],
    ['f=8', 'EINVAL:unsupported format f=8'],
  ])('%s', (keys, expected) => {
    expect(refusal(() => assertSupported(keysOf(keys)))).toBe(expected);
  });

  test('defaults to direct transmission of 32-bit pixels', () => {
    expect(refusal(() => assertSupported({}))).toBeNull();
  });
});

describe('transmissionSize', () => {
  test('raw pixels are sized by s and v', () => {
    expect(transmissionSize({ keys: keysOf('f=24,s=3,v=4'), data: '' })).toEqual({
      width: 3,
      height: 4,
    });
  });

  test('a PNG is sized from its header, a compressed one not until decoded', () => {
    const data = b64(pngHeader(20, 40));
    expect(transmissionSize({ keys: { f: '100' }, data })).toEqual({ width: 20, height: 40 });
    expect(transmissionSize({ keys: { f: '100', o: 'z' }, data })).toEqual({ width: 0, height: 0 });
  });

  test('a payload that is not a PNG is refused', () => {
    const run = () => transmissionSize({ keys: { f: '100' }, data: zeros(33) });
    expect(refusal(run)).toBe('EINVAL:not a PNG');
  });
});

describe('assertWithinLimits', () => {
  test.each([
    ['f=32', { width: 10, height: 10 }, null],
    ['f=32', { width: 11, height: 10 }, 'EINVAL:image too large'],
    ['f=32', { width: 0, height: 5 }, 'EINVAL:raw image needs positive integer s and v'],
    ['f=24', { width: 2.5, height: 5 }, 'EINVAL:raw image needs positive integer s and v'],
    ['f=100', { width: 0, height: 0 }, null],
    ['f=100', { width: 20, height: 10 }, 'EINVAL:image too large'],
  ])('%s %o', (keys, size, expected) => {
    expect(refusal(() => assertWithinLimits(keysOf(keys), size, 100))).toBe(expected);
  });
});

describe('decodeFootprint', () => {
  test('is the payload plus the RGBA, or the worst case when the size is unknown', () => {
    expect(decodeFootprint({ width: 2, height: 3 }, 10, 100)).toBe(10 + 24);
    expect(decodeFootprint({ width: 0, height: 0 }, 10, 100)).toBe(10 + 400);
  });
});

describe('decodeImage', () => {
  test('RGBA pixels are handed over as they are', async () => {
    const deps = new FakeDecoder();
    const bitmap = await decodeImage(
      keysOf('f=32,s=1,v=1'),
      b64(Uint8Array.of(1, 2, 3, 4)),
      100,
      deps,
    );
    expect(bitmap).toMatchObject({ width: 1, height: 1 });
    expect(deps.pixels).toEqual([[1, 2, 3, 4]]);
  });

  test('RGB pixels get an opaque alpha channel', async () => {
    const deps = new FakeDecoder();
    await decodeImage(keysOf('f=24,s=2,v=1'), b64(Uint8Array.of(1, 2, 3, 4, 5, 6)), 100, deps);
    expect(deps.pixels).toEqual([[1, 2, 3, 255, 4, 5, 6, 255]]);
  });

  test('compressed raw pixels are inflated', async () => {
    const payload = b64(deflateSync(Uint8Array.of(9, 9, 9, 9)));
    const bitmap = await decodeImage(keysOf('f=32,s=1,v=1,o=z'), payload, 100, new FakeDecoder());
    expect(bitmap.width).toBe(1);
  });

  test('a PNG goes to the browser as a file, compressed or not', async () => {
    const deps = new FakeDecoder();
    const plain = await decodeImage({ f: '100' }, b64(pngHeader(3, 4)), 100, deps);
    const zipped = await decodeImage(
      { f: '100', o: 'z' },
      b64(deflateSync(pngHeader(5, 6))),
      100,
      deps,
    );
    expect([plain.width, plain.height, zipped.width, zipped.height]).toEqual([3, 4, 5, 6]);
  });

  test.each([
    ['too little pixel data', 'f=32,s=10,v=10', zeros(8), 'ENODATA:not enough pixel data'],
    [
      'a zlib bomb',
      'f=32,s=2,v=2,o=z',
      b64(deflateSync(new Uint8Array(4096))),
      'EINVAL:decompressed data too large',
    ],
    [
      'an inflated PNG over the limit',
      'f=100,o=z',
      b64(deflateSync(pngHeader(11, 10))),
      'EINVAL:image too large',
    ],
    ['an inflated non-PNG', 'f=100,o=z', b64(deflateSync(new Uint8Array(40))), 'EINVAL:not a PNG'],
  ])('%s is refused', async (_name, keys, payload, expected) => {
    const decoding = decodeImage(keysOf(keys), payload, 100, new FakeDecoder());
    const error = await decoding.then(
      () => null,
      (e: KittyError) => `${e.code}:${e.message}`,
    );
    expect(error).toBe(expected);
  });
});

describe('BROWSER_DECODER', () => {
  const g = globalThis as { createImageBitmap?: unknown; ImageData?: unknown };
  const saved = { createImageBitmap: g.createImageBitmap, ImageData: g.ImageData };
  afterEach(() => Object.assign(g, saved));

  test("calls the browser's own constructors when used", async () => {
    g.ImageData = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
    g.createImageBitmap = async (source: { width: number; height: number }) =>
      fakeBitmap(source.width, source.height);
    const data = BROWSER_DECODER.createImageData(new Uint8ClampedArray(4), 1, 1);
    expect(data).toMatchObject({ width: 1, height: 1 });
    expect(await BROWSER_DECODER.createImageBitmap(data)).toMatchObject({ width: 1 });
  });
});
