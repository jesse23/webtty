// Reads a PNG's width and height from its IHDR (util, pure, ADR 032), from raw bytes or
// from the start of a base64 payload, so the cursor can move before the async decode.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Width and height from a PNG's IHDR, given the first 24 bytes of the file or
 * more. The header is checked in full (signature, that the first chunk is a
 * 13-byte IHDR, and that the dimensions are valid) because the result is used
 * to move the cursor before the decoder has looked at the data.
 */
export function pngSizeFromBytes(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  const u32 = (o: number): number =>
    ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  if (u32(8) !== 13) return null;
  if (u32(12) !== 0x49484452) return null; // "IHDR"
  const width = u32(16);
  const height = u32(20);
  // PNG dimensions are 1 to 2^31 - 1
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) return null;
  return { width, height };
}

/**
 * Width and height from a PNG's IHDR, read from the first 24 bytes of the
 * base64 payload. Lets cursor movement be computed before the (async) decode.
 * Only valid when the payload is not zlib-compressed.
 */
export function pngSize(base64: string): { width: number; height: number } | null {
  if (base64.length < 32) return null;
  let bin: string;
  try {
    bin = atob(base64.slice(0, 32));
  } catch {
    return null;
  }
  return pngSizeFromBytes(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
