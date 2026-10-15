// Kitty graphics protocol on top of ghostty-web, whose WASM core discards the APC
// sequences (facade, ADR 032): it routes each command to the image store, the decoder and
// the placement table, answers it, and owns the overlay they are drawn on.

import { type KittyKeys, num, parseKittyApc } from '../protocol/apc-command';
import { ApcSplitter } from '../protocol/apc-splitter';
import { ChunkAssembler, type Transmission } from '../protocol/chunk-assembler';
import { ControlScanner } from '../protocol/control-scanner';
import { kittyReply } from '../protocol/kitty-reply';
import {
  assertSupported,
  assertWithinLimits,
  BROWSER_DECODER,
  decodeFootprint,
  decodeImage,
  type ImageDecoderDeps,
  transmissionSize,
} from './image-decoder';
import { ImageStore, imageIdOf, type StoredImage } from './image-store';
import { KittyError } from './kitty-error';
import { DEFAULT_LIMITS, type KittyLimits } from './kitty-limits';
import { cellSize, deviceScale, type KittyTerminal, scrollbackLength } from './kitty-terminal';
import { OverlayCanvas, type OverlayDeps, type OverlaySource } from './overlay-canvas';
import { assertCursorMovable, cursorAdvance, placementAt } from './placement-geometry';
import { type Placement, Placements } from './placements';

/** The browser objects the overlay and the decoder use, injected so tests run on fakes. */
export interface KittyGraphicsDeps extends OverlayDeps {
  decoder: ImageDecoderDeps;
}

/** One transmission whose decode is running, and what its result is checked against. */
interface PendingDecode {
  keys: KittyKeys;
  id: number;
  /** Whether the command named the id; an anonymous image is answered with id 0. */
  explicit: boolean;
  slot: StoredImage;
  seq: number;
  generation: number;
  /** Bytes held against the budget until the decode settles. */
  reserved: number;
}

/**
 * `feed()` replaces `term.write()` for PTY output: it strips the graphics commands, hands
 * the rest to the terminal, and draws images on an overlay canvas. See ADR 032.
 */
export class KittyGraphics implements OverlaySource {
  /** Transmitted images; the overlay and tests read it, only this class changes it. */
  readonly images: ImageStore;
  /** Placed images; the overlay and tests read it, only this class changes it. */
  readonly placements = new Placements();
  private splitter: ApcSplitter;
  private assembler: ChunkAssembler;
  private scanner = new ControlScanner();
  // Bumped by reset(). Decodes that started under an older value are stale:
  // their result belongs to a PTY stream that is gone.
  private generation = 0;
  private readonly limits: KittyLimits;
  private readonly overlay: OverlayCanvas;

  constructor(
    private readonly term: KittyTerminal,
    container: HTMLElement,
    /** Sends bytes to the PTY as if typed: replies to queries go here. */
    private readonly send: (data: string) => void,
    limits: Partial<KittyLimits> = {},
    private readonly deps: KittyGraphicsDeps = {
      document: container.ownerDocument,
      window,
      decoder: BROWSER_DECODER,
    },
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.images = new ImageStore(this.limits, (id) =>
      this.removePlacements((p) => p.imageId === id),
    );
    this.splitter = new ApcSplitter(this.limits.maxTransmissionBytes);
    this.assembler = new ChunkAssembler(this.limits.maxTransmissionBytes);
    this.overlay = new OverlayCanvas(term, container, this, deps);
  }

  /** Repaint the overlay on the next frame, whatever has or has not changed. */
  invalidate(): void {
    this.overlay.invalidate();
  }

  /**
   * Forget everything from the previous PTY stream. Call when it restarts
   * (WebSocket reconnect): a connection can drop mid-APC, and the scrollback
   * replay that follows would otherwise be swallowed as payload; images and
   * in-flight decodes belong to the old stream and would answer, or draw,
   * into the new one.
   */
  reset(): void {
    this.generation++;
    this.splitter = new ApcSplitter(this.limits.maxTransmissionBytes);
    this.assembler = new ChunkAssembler(this.limits.maxTransmissionBytes);
    this.scanner = new ControlScanner();
    this.images.dropAll();
    this.clear();
  }

  /** Writes PTY output to the terminal, intercepting graphics commands. */
  feed(data: string): void {
    for (const seg of this.splitter.feed(data)) {
      if (seg.type === 'text') this.writeText(seg.text);
      else this.handleApc(seg.body, seg.overflow);
    }
  }

  /**
   * Placements no longer match what is on screen. Image data is kept: clients may re-place
   * it. Also called when the user clears the screen (ADR 054).
   */
  clear(): void {
    this.placements.clear();
    // Even when the table is already empty the overlay may still hold pixels
    // from placements removed without a repaint.
    this.overlay.markDirty();
  }

  /** Frees every image, stops answering running decodes and removes the overlay. Idempotent. */
  dispose(): void {
    this.generation++;
    this.images.dropAll();
    this.placements.clear();
    this.overlay.dispose();
  }

  private writeText(text: string): void {
    this.term.write(text);
    // Size queries (CSI 14/16/18 t) are answered by Ghostty (OPT_SIZE). See ADR 042
    // and ADR 047.
    if (this.scanner.scan(text)) this.clear();
  }

  private handleApc(body: string, overflow = false): void {
    const cmd = parseKittyApc(body);
    if (!cmd) return;
    // An oversized sequence arrives as its start only: enough to answer it.
    const tx = overflow ? this.assembler.reject(cmd) : this.assembler.push(cmd);
    if (!tx) return;
    const action = tx.keys.a ?? 't';
    try {
      if (tx.tooBig) throw new KittyError('EINVAL', 'transmission too large');
      if (action === 'q') this.query(tx);
      else if (action === 't' || action === 'T') this.transmit(tx, action === 'T');
      else if (action === 'p') {
        const id = this.requireImage(tx.keys);
        this.place(tx.keys, id);
        this.reply(tx.keys, id);
      } else if (action === 'd') this.delete(tx.keys);
    } catch (e) {
      this.replyError(tx.keys, e);
    }
  }

  // A transmitted image counts as existing while its decode is still running:
  // programs send `a=t` and `a=p` back to back, and the placement simply waits
  // for the bitmap.
  private requireImage(keys: KittyKeys): number {
    const id = imageIdOf(keys);
    if (!this.images.get(id)) throw new KittyError('ENOENT', 'no such image');
    return id;
  }

  private query(tx: Transmission): void {
    assertSupported(tx.keys);
    this.reply(tx.keys, imageIdOf(tx.keys));
  }

  private transmit(tx: Transmission, display: boolean): void {
    assertSupported(tx.keys);
    const size = transmissionSize(tx);
    assertWithinLimits(tx.keys, size, this.limits.maxImagePixels);
    // Only a decode can tell a compressed PNG's size, and the cursor has to
    // move at this exact point in the stream, so it cannot be moved for one.
    if (display) assertCursorMovable(tx.keys, size);

    // Stored images make room for what the decode holds; if it still does not fit, it is refused.
    const reserved = decodeFootprint(size, tx.data.length, this.limits.maxImagePixels);
    if (!this.images.enforceBudget(false, reserved)) {
      throw new KittyError('EINVAL', 'too many images being decoded');
    }

    const explicit = imageIdOf(tx.keys);
    const id = explicit || this.images.nextAnonymousId();
    const generation = this.generation;
    // Re-sending an id replaces the image and drops its old placements.
    this.removePlacements((p) => p.imageId === id);
    const { slot, seq } = this.images.open(id, size);

    // Placement is recorded now, before the decode finishes; the draw simply
    // waits for the bitmap.
    if (display) this.place(tx.keys, id);

    // Every path below ends the transmission with a reply, except when the
    // stream it belongs to has been reset: nobody is waiting for it any more.
    this.images.holdInFlight(reserved);
    const pending: PendingDecode = {
      keys: tx.keys,
      id,
      explicit: explicit !== 0,
      slot,
      seq,
      generation,
      reserved,
    };
    decodeImage(tx.keys, tx.data, this.limits.maxImagePixels, this.deps.decoder).then(
      (bitmap) => this.decoded(pending, bitmap),
      (e) => this.decodeFailed(pending, e),
    );
  }

  private decoded(d: PendingDecode, bitmap: ImageBitmap): void {
    this.images.releaseInFlight(d.reserved);
    if (d.generation !== this.generation) {
      bitmap.close();
      return;
    }
    const result = this.images.install(d.id, d.slot, d.seq, bitmap);
    if (result === 'removed') {
      this.replyError(
        d.keys,
        new KittyError('EINVAL', 'image was removed before it finished decoding'),
      );
      return;
    }
    // 'superseded': a newer transmission is already showing. This one was valid.
    if (result === 'installed') this.overlay.markDirty();
    this.reply(d.keys, d.explicit ? d.id : 0);
  }

  private decodeFailed(d: PendingDecode, e: unknown): void {
    this.images.releaseInFlight(d.reserved);
    if (d.generation !== this.generation) return;
    // The newest transmission failed: nothing it placed can be drawn, and
    // an image that never decoded is not worth keeping.
    if (this.images.isNewest(d.id, d.slot, d.seq)) {
      this.removePlacements((p) => p.imageId === d.id);
      if (!d.slot.bitmap) this.images.drop(d.id);
    }
    this.replyError(d.keys, e);
  }

  private place(keys: KittyKeys, imageId: number): void {
    // Sized from the slot, which describes the latest transmission; a bitmap
    // can still be the previous transmission's while this one decodes.
    const image = this.images.get(imageId) ?? { width: 0, height: 0 };
    assertCursorMovable(keys, image);
    const buf = this.term.buffer.active;
    const cell = cellSize(this.term);
    const scale = deviceScale(cell, this.deps.window.devicePixelRatio);
    const at = { absRow: scrollbackLength(this.term) + buf.cursorY, col: buf.cursorX };
    const p = placementAt(keys, imageId, at, scale);
    this.placements.add(p);
    this.overlay.markDirty();
    const advance = cursorAdvance(keys, p, image, cell);
    if (advance !== null) this.term.write(advance);
  }

  // The protocol defines no success reply for a delete, so none is sent.
  private delete(keys: KittyKeys): void {
    const target = keys.d ?? 'a';
    if (target === 'a' || target === 'A') {
      this.removePlacements(() => true);
      if (target === 'A') this.images.dropAll();
    } else if (target === 'i' || target === 'I') {
      const id = imageIdOf(keys);
      const pid = keys.p !== undefined ? num(keys, 'p') : undefined;
      this.removePlacements(
        (p) => p.imageId === id && (pid === undefined || p.placementId === pid),
      );
      if (target === 'I') this.images.drop(id);
    }
  }

  // Every path that removes a placement goes through here so the overlay is
  // repainted: a placement gone from the table but still painted would stay on
  // screen until something unrelated redraws.
  private removePlacements(match: (p: Placement) => boolean): void {
    if (this.placements.removeWhere(match)) this.overlay.markDirty();
  }

  private reply(keys: KittyKeys, id: number): void {
    const r = kittyReply(keys, id);
    if (r) this.send(r);
  }

  private replyError(keys: KittyKeys, e: unknown): void {
    const code = e instanceof KittyError ? e.code : 'EBADF';
    const message = e instanceof Error ? e.message : 'decode failed';
    const r = kittyReply(keys, imageIdOf(keys), { code, message });
    if (r) this.send(r);
  }
}
