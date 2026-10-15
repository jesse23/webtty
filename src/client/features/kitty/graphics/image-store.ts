// The images a PTY program has transmitted, by id (object, ADR 032): their decoded
// bitmaps, oldest first, and the memory they and the decodes still running hold, kept
// within the image count and byte budget by dropping the oldest.

import { type KittyKeys, num } from '../protocol/apc-command';
import type { KittyLimits } from './kitty-limits';

// Kitty image numbers (`I=`) are per-client handles the terminal maps to ids.
// Give them ids far above anything a client picks itself.
const IMAGE_NUMBER_BASE = 0x40000000;

/** The image id a command names with `i=` or `I=`, or 0 when it names none. */
export function imageIdOf(keys: KittyKeys): number {
  if (keys.i !== undefined) return num(keys, 'i');
  if (keys.I !== undefined) return IMAGE_NUMBER_BASE + num(keys, 'I');
  return 0;
}

/** One image's slot; it outlives the transmissions that replace its bitmap. */
export interface StoredImage {
  bitmap?: ImageBitmap;
  // Pixel size known when the transmission arrived (raw `s`/`v`, or an
  // uncompressed PNG header), 0 when only the decode will tell. Lets a
  // placement be recorded, and the cursor moved, before decoding finishes.
  width: number;
  height: number;
  // Decoded size in bytes, counted against `maxTotalBytes`.
  bytes: number;
  // Decodes can finish out of order when frames arrive faster than they
  // decode. A bitmap never replaces one from a newer transmission, but an
  // older one that finishes first is shown until the newer is ready: dropping
  // it would leave a stream of frames blank whenever decoding lags behind.
  latest: number;
  applied: number;
}

/** What `install` did with a finished decode's bitmap. */
export type InstallResult = 'installed' | 'superseded' | 'removed';

/**
 * Images by id in recency order (a Map keeps insertion order, and a re-transmitted id is
 * re-inserted). Every drop goes through `drop`, which tells the owner so the image's
 * placements go with it.
 */
export class ImageStore {
  private readonly images = new Map<number, StoredImage>();
  private totalBytes = 0;
  // Encoded payloads and RGBA output of decodes that have not finished, which
  // hold memory just as stored images do and count against the same budget.
  private inFlightBytes = 0;
  private anonymousId = 0;

  constructor(
    private readonly limits: Pick<KittyLimits, 'maxImages' | 'maxTotalBytes'>,
    /** Called after an image is dropped, for any reason. */
    private readonly onDrop: (id: number) => void,
  ) {}

  /** Number of images held, decoded or still decoding. */
  get size(): number {
    return this.images.size;
  }

  /** Image ids, oldest first. */
  ids(): number[] {
    return [...this.images.keys()];
  }

  /** The slot for `id`; a transmitted image exists while its decode is still running. */
  get(id: number): StoredImage | undefined {
    return this.images.get(id);
  }

  /** The bitmap to draw for `id`, once a decode of it has finished. */
  bitmapOf(id: number): ImageBitmap | undefined {
    return this.images.get(id)?.bitmap;
  }

  /** A fresh id for a transmission that names none, counting down so it never meets a client's. */
  nextAnonymousId(): number {
    return --this.anonymousId;
  }

  /**
   * Starts a transmission into `id`: its slot (kept if it exists, so an older bitmap stays
   * on screen) becomes the newest, takes the transmission's size, and the oldest images
   * past `maxImages` are evicted. Returns the slot and the transmission's sequence number.
   */
  open(id: number, size: { width: number; height: number }): { slot: StoredImage; seq: number } {
    const slot = this.images.get(id) ?? { width: 0, height: 0, bytes: 0, latest: 0, applied: 0 };
    this.images.delete(id); // re-insert so the Map stays ordered by recency
    this.images.set(id, slot);
    // The size of this transmission, not of any bitmap still held from the
    // previous one: placements are sized from it.
    slot.width = size.width;
    slot.height = size.height;
    this.evict();
    return { slot, seq: ++slot.latest };
  }

  /**
   * Hands a finished decode's bitmap to its slot. It is closed instead when the slot was
   * removed meanwhile, or when a newer transmission's bitmap is already shown.
   */
  install(id: number, slot: StoredImage, seq: number, bitmap: ImageBitmap): InstallResult {
    if (this.images.get(id) !== slot) {
      bitmap.close();
      return 'removed';
    }
    if (seq <= slot.applied) {
      bitmap.close();
      return 'superseded';
    }
    slot.bitmap?.close();
    slot.bitmap = bitmap;
    slot.applied = seq;
    // For the newest transmission the decode is what tells a compressed
    // PNG's size, which a later a=p is placed from.
    if (seq === slot.latest) {
      slot.width = bitmap.width;
      slot.height = bitmap.height;
    }
    const bytes = bitmap.width * bitmap.height * 4;
    this.totalBytes += bytes - slot.bytes;
    slot.bytes = bytes;
    this.enforceBudget();
    return 'installed';
  }

  /** Whether transmission `seq` is still the newest one into a slot that is still held. */
  isNewest(id: number, slot: StoredImage, seq: number): boolean {
    return this.images.get(id) === slot && seq === slot.latest;
  }

  /** Counts a running decode's memory against the budget until `releaseInFlight`. */
  holdInFlight(bytes: number): void {
    this.inFlightBytes += bytes;
  }

  /** Releases what `holdInFlight` counted, when the decode settles. */
  releaseInFlight(bytes: number): void {
    this.inFlightBytes -= bytes;
  }

  /** Frees one image's bitmap and memory; the owner drops its placements. */
  drop(id: number): void {
    const slot = this.images.get(id);
    if (!slot) return;
    slot.bitmap?.close();
    this.totalBytes -= slot.bytes;
    this.images.delete(id);
    this.onDrop(id);
  }

  /** Frees every image. */
  dropAll(): void {
    for (const id of [...this.images.keys()]) this.drop(id);
  }

  /**
   * Drops the oldest images until stored plus in-flight bytes, and `extra`
   * more, fit the budget; the most recent transmission is kept unless
   * `protectNewest` is false. Returns whether it fits.
   */
  enforceBudget(protectNewest = true, extra = 0): boolean {
    const fits = () => this.totalBytes + this.inFlightBytes + extra <= this.limits.maxTotalBytes;
    const ids = [...this.images.keys()];
    if (protectNewest) ids.pop();
    for (const id of ids) {
      if (fits()) return true;
      this.drop(id);
    }
    return fits();
  }

  private evict(): void {
    while (this.images.size > this.limits.maxImages) {
      this.drop(this.images.keys().next().value as number);
    }
  }
}
