// Turns a kitty transmission into an ImageBitmap (service, async, ADR 032), and the checks
// that refuse one before anything is allocated: the medium, the format, the size it
// declares and the pixel limit.

import { type KittyKeys, num } from '../protocol/apc-command';
import { MAX_TRANSMISSION_BYTES, type Transmission } from '../protocol/chunk-assembler';
import { pngSize, pngSizeFromBytes } from '../protocol/png-size';
import { KittyError } from './kitty-error';

/** An image's size in device pixels; 0 x 0 when only the decode can tell. */
export interface PixelSize {
  width: number;
  height: number;
}

/** The browser's image constructors, injected so the decode runs without a browser. */
export interface ImageDecoderDeps {
  createImageBitmap(source: ImageBitmapSource): Promise<ImageBitmap>;
  createImageData(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ImageData;
}

/** The browser's own constructors, looked up when called. */
export const BROWSER_DECODER: ImageDecoderDeps = {
  createImageBitmap: (source) => createImageBitmap(source),
  createImageData: (rgba, width, height) => new ImageData(rgba, width, height),
};

/** Refuses a transmission medium other than direct (`t=d`) and a format other than 24, 32 or 100. */
export function assertSupported(keys: KittyKeys): void {
  const medium = keys.t ?? 'd';
  if (medium !== 'd') throw new KittyError('EINVAL', `unsupported transmission medium t=${medium}`);
  const format = num(keys, 'f', 32);
  if (format !== 24 && format !== 32 && format !== 100) {
    throw new KittyError('EINVAL', `unsupported format f=${format}`);
  }
}

/** Pixel size known synchronously from the command (raw `s`/`v` or PNG header). */
export function transmissionSize(tx: Transmission): PixelSize {
  if (num(tx.keys, 'f', 32) !== 100) return { width: num(tx.keys, 's'), height: num(tx.keys, 'v') };
  // A compressed PNG's size is only known once it is inflated.
  if (tx.keys.o === 'z') return { width: 0, height: 0 };
  const size = pngSize(tx.data);
  if (!size) throw new KittyError('EINVAL', 'not a PNG');
  return size;
}

/** Rejects what would be too big to hold, before any allocation. */
export function assertWithinLimits(keys: KittyKeys, size: PixelSize, maxImagePixels: number): void {
  if (num(keys, 'f', 32) !== 100) {
    const { width, height } = size;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new KittyError('EINVAL', 'raw image needs positive integer s and v');
    }
  }
  if (size.width * size.height > maxImagePixels) {
    throw new KittyError('EINVAL', 'image too large');
  }
}

/**
 * What a transmission holds while it decodes: its encoded payload and the RGBA it will
 * produce (the worst case, `maxImagePixels`, when only the decode can tell).
 */
export function decodeFootprint(
  size: PixelSize,
  payloadLength: number,
  maxImagePixels: number,
): number {
  const known = size.width && size.height;
  return payloadLength + (known ? size.width * size.height : maxImagePixels) * 4;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The protocol's `o=z` is zlib-wrapped deflate, which the web API calls
// 'deflate'. Reads incrementally so a small payload that expands past `limit`
// is cut off instead of allocated.
async function inflate(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new KittyError('EINVAL', 'decompressed data too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Decodes a transmission's base64 payload (raw RGB or RGBA, or a PNG file, optionally
 * zlib-compressed) into a bitmap. A PNG over `maxPixels` is refused once its header is
 * known; raw data shorter than `s` x `v` pixels is ENODATA.
 */
export async function decodeImage(
  keys: KittyKeys,
  data: string,
  maxPixels: number,
  deps: ImageDecoderDeps = BROWSER_DECODER,
): Promise<ImageBitmap> {
  const format = num(keys, 'f', 32);
  const width = num(keys, 's');
  const height = num(keys, 'v');
  const bpp = format === 24 ? 3 : 4;
  let bytes = base64ToBytes(data);
  if (keys.o === 'z') {
    // Raw pixels have an exact expected size; a PNG file is bounded by the
    // image-size limit's worst case.
    bytes = await inflate(bytes, format === 100 ? MAX_TRANSMISSION_BYTES : width * height * bpp);
  }
  if (format === 100) {
    const size = pngSizeFromBytes(bytes);
    if (!size) throw new KittyError('EINVAL', 'not a PNG');
    if (size.width * size.height > maxPixels) {
      throw new KittyError('EINVAL', 'image too large');
    }
    return deps.createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  }
  if (bytes.length < width * height * bpp) throw new KittyError('ENODATA', 'not enough pixel data');
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (format === 32) {
    rgba.set(bytes.subarray(0, width * height * 4));
  } else {
    for (let s = 0, d = 0; d < rgba.length; s += 3, d += 4) {
      rgba[d] = bytes[s];
      rgba[d + 1] = bytes[s + 1];
      rgba[d + 2] = bytes[s + 2];
      rgba[d + 3] = 255;
    }
  }
  return deps.createImageBitmap(deps.createImageData(rgba, width, height));
}
