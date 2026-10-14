// Reassembles chunked kitty transmissions (object, pure, ADR 032): `m=1` chunks are held
// until the final one, and a transmission over the size cap is reported once, at its end.

import type { KittyCommand, KittyKeys } from './apc-command';

/** A whole transmission: the first chunk's keys and every chunk's payload joined. */
export interface Transmission {
  keys: KittyKeys;
  data: string;
  /** The chunks added up to more than the size cap and were dropped; `data` is empty. */
  tooBig?: boolean;
}

/**
 * Cap on one chunked transmission's total encoded size. `MAX_APC_BYTES` bounds a
 * single sequence, but a client can send any number of `m=1` chunks that are
 * each valid, and every payload is held until the final one arrives.
 */
export const MAX_TRANSMISSION_BYTES = 64 * 1024 * 1024;

/**
 * Reassembles chunked transmissions. The first chunk carries every key; the
 * following ones carry only `m` (and optionally `q`). `m=1` means more
 * follows, `m=0` or absent ends it.
 *
 * A transmission that grows past `maxBytes` is dropped and the rest of its
 * chunks are swallowed, so they are not mistaken for new transmissions. The
 * caller gets a `tooBig` result once the final chunk arrives, to reply to.
 */
export class ChunkAssembler {
  private pending: { keys: KittyKeys; parts: string[]; size: number } | null = null;
  private discarding: KittyKeys | null = null;

  constructor(private maxBytes = MAX_TRANSMISSION_BYTES) {}

  /**
   * A chunk that could not be delivered whole (the splitter's size limit). Its
   * control keys are all that is known; treat it as the end of an oversized
   * transmission, or as one more chunk of one if it says more follows.
   */
  reject(cmd: KittyCommand): Transmission | null {
    const keys = this.pending?.keys ?? this.discarding ?? cmd.keys;
    this.pending = null;
    if (cmd.keys.m === '1') {
      this.discarding = keys;
      return null;
    }
    this.discarding = null;
    return { keys, data: '', tooBig: true };
  }

  push(cmd: KittyCommand): Transmission | null {
    const more = cmd.keys.m === '1';
    if (this.discarding) {
      if (more) return null;
      const keys = this.discarding;
      this.discarding = null;
      return { keys, data: '', tooBig: true };
    }
    const size = (this.pending?.size ?? 0) + cmd.payload.length;
    if (size > this.maxBytes) {
      const keys = this.pending?.keys ?? cmd.keys;
      this.pending = null;
      if (more) {
        this.discarding = keys;
        return null;
      }
      return { keys, data: '', tooBig: true };
    }
    if (!this.pending) {
      if (!more) return { keys: cmd.keys, data: cmd.payload };
      this.pending = { keys: cmd.keys, parts: [cmd.payload], size };
      return null;
    }
    this.pending.parts.push(cmd.payload);
    this.pending.size = size;
    if (more) return null;
    const done = { keys: this.pending.keys, data: this.pending.parts.join('') };
    this.pending = null;
    return done;
  }
}
