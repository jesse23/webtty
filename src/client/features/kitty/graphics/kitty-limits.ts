// Bounds on what a PTY program can make the tab hold (constants, ADR 032). Raw dimensions
// drive the RGBA allocation and a small zlib payload can expand enormously, so limits are
// checked before anything is allocated or decoded, and again on what a decode produces.

import { MAX_TRANSMISSION_BYTES } from '../protocol/chunk-assembler';

/** The limits one `KittyGraphics` enforces; tests lower them to reach each refusal. */
export interface KittyLimits {
  /** Images kept, whatever their size. */
  maxImages: number;
  /** Pixels in one image. */
  maxImagePixels: number;
  /** Decoded bytes across all images kept. */
  maxTotalBytes: number;
  /** Encoded bytes in one transmission, however many chunks it is sent in. */
  maxTransmissionBytes: number;
}

/**
 * The production limits. A 32M-pixel image is 128 MiB as RGBA; full-window frames on
 * large HiDPI displays are around 15M pixels.
 */
export const DEFAULT_LIMITS: KittyLimits = {
  maxImages: 256,
  maxImagePixels: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxTransmissionBytes: MAX_TRANSMISSION_BYTES,
};
