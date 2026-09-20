import type { Terminal } from 'ghostty-web';
import {
  ApcSplitter,
  axisScale,
  ChunkAssembler,
  ControlScanner,
  cellSpan,
  deviceCellSize,
  type KittyKeys,
  kittyReply,
  MAX_TRANSMISSION_BYTES,
  num,
  parseKittyApc,
  pngSize,
  pngSizeFromBytes,
  sizeReply,
  type Transmission,
} from './kitty';

// Sizes reported to programs (CSI 14t/16t) are device pixels, as in kitty and
// Ghostty: programs such as terminal-browser divide them by the display's
// scale factor to get CSS pixels, so reporting CSS pixels makes their content
// render at the wrong size. On a 2x display this means 4x the pixels per
// full-window frame. Cell sizes are whole device pixels (see kitty.ts), so the
// CSS-to-device scale is per axis. See ADR 032.
interface Scale {
  x: number;
  y: number;
}

// Bounds on what a PTY program can make the tab hold. Raw dimensions drive the
// RGBA allocation and a small zlib payload can expand enormously, so limits are
// checked before anything is allocated or decoded, and again on what a decode
// produces. A 32M-pixel image is 128 MiB as RGBA; full-window frames on large
// HiDPI displays are around 15M pixels.
export interface Limits {
  /** Images kept, whatever their size. */
  maxImages: number;
  /** Pixels in one image. */
  maxImagePixels: number;
  /** Decoded bytes across all images kept. */
  maxTotalBytes: number;
  /** Encoded bytes in one transmission, however many chunks it is sent in. */
  maxTransmissionBytes: number;
}

const DEFAULT_LIMITS: Limits = {
  maxImages: 256,
  maxImagePixels: 32 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxTransmissionBytes: MAX_TRANSMISSION_BYTES,
};

// Kitty image numbers (`I=`) are per-client handles the terminal maps to ids.
// Give them ids far above anything a client picks itself.
const IMAGE_NUMBER_BASE = 0x40000000;

interface StoredImage {
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

interface Placement {
  imageId: number;
  placementId: number;
  /** Row in absolute buffer coordinates: scrollback length + viewport row. */
  absRow: number;
  col: number;
  cols?: number;
  rows?: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  offX: number;
  offY: number;
  /** Device pixels per CSS pixel when placed; the image was sized for this. */
  scale: Scale;
}

class KittyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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

async function decode(keys: KittyKeys, data: string, maxPixels: number): Promise<ImageBitmap> {
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
    return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
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
  return createImageBitmap(new ImageData(rgba, width, height));
}

/**
 * Kitty graphics protocol on top of ghostty-web, whose WASM core discards the
 * APC sequences. `feed()` replaces `term.write()` for PTY output: it strips the
 * graphics commands, hands the rest to the terminal, and draws images on an
 * overlay canvas. See ADR 032.
 */
export class KittyGraphics {
  private splitter: ApcSplitter;
  private assembler: ChunkAssembler;
  private scanner = new ControlScanner();
  private images = new Map<number, StoredImage>();
  private totalBytes = 0;
  // Encoded payloads and RGBA output of decodes that have not finished, which
  // hold memory just as stored images do and count against the same budget.
  private inFlightBytes = 0;
  private placements = new Map<string, Placement>();
  private anonymousId = 0;
  // Bumped by reset(). Decodes that started under an older value are stale:
  // their result belongs to a PTY stream that is gone.
  private generation = 0;
  private limits: Limits;
  private overlay: HTMLCanvasElement;
  private dirty = false;
  private lastSignature = '';

  constructor(
    private term: Terminal,
    private container: HTMLElement,
    /** Sends bytes to the PTY as if typed: replies to queries go here. */
    private send: (data: string) => void,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.splitter = new ApcSplitter(this.limits.maxTransmissionBytes);
    this.assembler = new ChunkAssembler(this.limits.maxTransmissionBytes);
    this.overlay = document.createElement('canvas');
    this.overlay.dataset.kitty = '';
    this.overlay.style.cssText = 'position:absolute;pointer-events:none;';
    container.appendChild(this.overlay);
    requestAnimationFrame(this.tick);
    // Chromium can discard a canvas's contents while its tab is hidden. The
    // overlay's geometry does not change when the tab comes back, so nothing
    // else would make it repaint.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.invalidate();
    });
  }

  /** Repaint the overlay on the next frame, whatever has or has not changed. */
  invalidate(): void {
    this.dirty = true;
    this.lastSignature = '';
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
    this.dropImages();
    this.clear();
  }

  /** Writes PTY output to the terminal, intercepting graphics commands. */
  feed(data: string): void {
    for (const seg of this.splitter.feed(data)) {
      if (seg.type === 'text') this.writeText(seg.text);
      else this.handleApc(seg.body, seg.overflow);
    }
  }

  private writeText(text: string): void {
    this.term.write(text);
    const { clears, queries } = this.scanner.scan(text);
    if (clears) this.clear();
    for (const q of queries) this.send(sizeReply(q, this.terminalSize()));
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

  private imageIdOf(keys: KittyKeys): number {
    if (keys.i !== undefined) return num(keys, 'i');
    if (keys.I !== undefined) return IMAGE_NUMBER_BASE + num(keys, 'I');
    return 0;
  }

  // A transmitted image counts as existing while its decode is still running:
  // programs send `a=t` and `a=p` back to back, and the placement simply waits
  // for the bitmap.
  private requireImage(keys: KittyKeys): number {
    const id = this.imageIdOf(keys);
    if (!this.images.has(id)) throw new KittyError('ENOENT', 'no such image');
    return id;
  }

  private assertSupported(keys: KittyKeys): void {
    const medium = keys.t ?? 'd';
    if (medium !== 'd')
      throw new KittyError('EINVAL', `unsupported transmission medium t=${medium}`);
    const format = num(keys, 'f', 32);
    if (format !== 24 && format !== 32 && format !== 100) {
      throw new KittyError('EINVAL', `unsupported format f=${format}`);
    }
  }

  private query(tx: Transmission): void {
    this.assertSupported(tx.keys);
    this.reply(tx.keys, this.imageIdOf(tx.keys));
  }

  /** Rejects what would be too big to hold, before any allocation. */
  private assertWithinLimits(keys: KittyKeys, size: { width: number; height: number }): void {
    if (num(keys, 'f', 32) !== 100) {
      const { width, height } = size;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new KittyError('EINVAL', 'raw image needs positive integer s and v');
      }
    }
    if (size.width * size.height > this.limits.maxImagePixels) {
      throw new KittyError('EINVAL', 'image too large');
    }
  }

  private transmit(tx: Transmission, display: boolean): void {
    this.assertSupported(tx.keys);
    const size = this.dimensions(tx);
    this.assertWithinLimits(tx.keys, size);
    // Only a decode can tell a compressed PNG's size, and the cursor has to
    // move at this exact point in the stream, so it cannot be moved for one.
    if (display) this.assertCursorMovable(tx.keys, size);

    // What this transmission holds while it decodes: its encoded payload and the
    // RGBA it will produce (the worst case when only the decode can tell).
    // Stored images make room for it; if it still does not fit, it is refused.
    const known = size.width && size.height;
    const reserved =
      tx.data.length + (known ? size.width * size.height : this.limits.maxImagePixels) * 4;
    if (!this.enforceBudget(false, reserved)) {
      throw new KittyError('EINVAL', 'too many images being decoded');
    }

    const explicit = this.imageIdOf(tx.keys);
    const id = explicit || --this.anonymousId;
    const gen = this.generation;

    // Re-sending an id replaces the image and drops its old placements.
    this.removePlacements((p) => p.imageId === id);
    const slot = this.images.get(id) ?? { width: 0, height: 0, bytes: 0, latest: 0, applied: 0 };
    this.images.delete(id); // re-insert so the Map stays ordered by recency
    this.images.set(id, slot);
    // The size of this transmission, not of any bitmap still held from the
    // previous one: placements are sized from it.
    slot.width = size.width;
    slot.height = size.height;
    this.evict();
    const seq = ++slot.latest;

    // Placement is recorded now, before the decode finishes; the draw simply
    // waits for the bitmap.
    if (display) this.place(tx.keys, id);

    // Every path below ends the transmission with a reply, except when the
    // stream it belongs to has been reset: nobody is waiting for it any more.
    this.inFlightBytes += reserved;
    decode(tx.keys, tx.data, this.limits.maxImagePixels).then(
      (bitmap) => {
        this.inFlightBytes -= reserved;
        if (gen !== this.generation) {
          bitmap.close();
          return;
        }
        if (this.images.get(id) !== slot) {
          bitmap.close();
          this.replyError(
            tx.keys,
            new KittyError('EINVAL', 'image was removed before it finished decoding'),
          );
          return;
        }
        if (seq <= slot.applied) {
          // A newer transmission is already showing. This one was valid.
          bitmap.close();
          this.reply(tx.keys, explicit ? id : 0);
          return;
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
        this.dirty = true;
        this.reply(tx.keys, explicit ? id : 0);
      },
      (e) => {
        this.inFlightBytes -= reserved;
        if (gen !== this.generation) return;
        // The newest transmission failed: nothing it placed can be drawn, and
        // an image that never decoded is not worth keeping.
        if (this.images.get(id) === slot && seq === slot.latest) {
          this.removePlacements((p) => p.imageId === id);
          if (!slot.bitmap) this.dropImage(id);
        }
        this.replyError(tx.keys, e);
      },
    );
  }

  /** Pixel size known synchronously from the command (raw `s`/`v` or PNG header). */
  private dimensions(tx: Transmission): { width: number; height: number } {
    if (num(tx.keys, 'f', 32) !== 100)
      return { width: num(tx.keys, 's'), height: num(tx.keys, 'v') };
    // A compressed PNG's size is only known once it is inflated.
    if (tx.keys.o === 'z') return { width: 0, height: 0 };
    const size = pngSize(tx.data);
    if (!size) throw new KittyError('EINVAL', 'not a PNG');
    return size;
  }

  private assertCursorMovable(keys: KittyKeys, size: { width: number; height: number }): void {
    if (num(keys, 'C') === 1 || (size.width && size.height)) return;
    throw new KittyError('EINVAL', 'size of a compressed PNG is unknown until decoded: use C=1');
  }

  private place(keys: KittyKeys, imageId: number): void {
    // Sized from the slot, which describes the latest transmission; a bitmap
    // can still be the previous transmission's while this one decodes.
    const image = this.images.get(imageId) ?? { width: 0, height: 0 };
    this.assertCursorMovable(keys, image);
    const buf = this.term.buffer.active;
    const cell = this.cell();
    const scale = this.scale();
    const p: Placement = {
      imageId,
      placementId: num(keys, 'p'),
      absRow: this.scrollbackLength() + buf.cursorY,
      col: buf.cursorX,
      srcX: num(keys, 'x'),
      srcY: num(keys, 'y'),
      srcW: num(keys, 'w'),
      srcH: num(keys, 'h'),
      offX: num(keys, 'X'),
      offY: num(keys, 'Y'),
      scale,
    };
    if (keys.c !== undefined) p.cols = num(keys, 'c');
    if (keys.r !== undefined) p.rows = num(keys, 'r');
    this.placements.set(`${imageId}:${p.placementId}`, p);
    this.dirty = true;

    // Default C=0: the cursor ends past the image (last row, right of the
    // last column). The WASM cannot know an image took space, so move it.
    if (num(keys, 'C') === 1) return;
    // The shown region is the source rectangle when given; `w` / `h` are
    // device pixels like the image, so they convert with the same scale.
    const region = {
      width: (p.srcW || Math.max(1, image.width - p.srcX)) / scale.x,
      height: (p.srcH || Math.max(1, image.height - p.srcY)) / scale.y,
    };
    const span = cellSpan(keys, region, cell.width, cell.height);
    this.term.write(`${'\n'.repeat(span.rows - 1)}\x1b[${p.col + span.cols + 1}G`);
  }

  // The protocol defines no success reply for a delete, so none is sent.
  private delete(keys: KittyKeys): void {
    const target = keys.d ?? 'a';
    if (target === 'a' || target === 'A') {
      this.removePlacements(() => true);
      if (target === 'A') this.dropImages();
    } else if (target === 'i' || target === 'I') {
      const id = this.imageIdOf(keys);
      const pid = keys.p !== undefined ? num(keys, 'p') : undefined;
      this.removePlacements(
        (p) => p.imageId === id && (pid === undefined || p.placementId === pid),
      );
      if (target === 'I') this.dropImage(id);
    }
  }

  // Every path that removes a placement goes through here so the overlay is
  // repainted: a placement gone from the map but still painted would stay on
  // screen until something unrelated redraws.
  private removePlacements(match: (p: Placement) => boolean): void {
    for (const [key, p] of this.placements) {
      if (!match(p)) continue;
      this.placements.delete(key);
      this.dirty = true;
    }
  }

  private dropImage(id: number): void {
    const slot = this.images.get(id);
    if (!slot) return;
    slot.bitmap?.close();
    this.totalBytes -= slot.bytes;
    this.images.delete(id);
    this.removePlacements((p) => p.imageId === id);
  }

  private dropImages(): void {
    for (const id of [...this.images.keys()]) this.dropImage(id);
  }

  /** Placements no longer match what is on screen. Image data is kept: clients may re-place it. */
  private clear(): void {
    this.placements.clear();
    // Even when the map is already empty the overlay may still hold pixels
    // from placements removed without a repaint.
    this.dirty = true;
  }

  private evict(): void {
    while (this.images.size > this.limits.maxImages) {
      this.dropImage(this.images.keys().next().value as number);
    }
  }

  /**
   * Drops the oldest images until stored plus in-flight bytes, and `extra`
   * more, fit the budget; the most recent transmission is kept unless
   * `protectNewest` is false. Returns whether it fits.
   */
  private enforceBudget(protectNewest = true, extra = 0): boolean {
    const fits = () => this.totalBytes + this.inFlightBytes + extra <= this.limits.maxTotalBytes;
    const ids = [...this.images.keys()];
    if (protectNewest) ids.pop();
    for (const id of ids) {
      if (fits()) return true;
      this.dropImage(id);
    }
    return fits();
  }

  private reply(keys: KittyKeys, id: number): void {
    const r = kittyReply(keys, id);
    if (r) this.send(r);
  }

  private replyError(keys: KittyKeys, e: unknown): void {
    const code = e instanceof KittyError ? e.code : 'EBADF';
    const message = e instanceof Error ? e.message : 'decode failed';
    const r = kittyReply(keys, this.imageIdOf(keys), { code, message });
    if (r) this.send(r);
  }

  // ---- geometry and drawing --------------------------------------------

  private scale(): Scale {
    const cell = this.cell();
    const dpr = window.devicePixelRatio || 1;
    return { x: axisScale(cell.width, dpr), y: axisScale(cell.height, dpr) };
  }

  private cell(): { width: number; height: number } {
    const m = this.term.renderer?.getMetrics();
    return { width: m?.width ?? 8, height: m?.height ?? 16 };
  }

  private terminalSize() {
    const cell = this.cell();
    const dpr = window.devicePixelRatio || 1;
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cellWidth: deviceCellSize(cell.width, dpr),
      cellHeight: deviceCellSize(cell.height, dpr),
    };
  }

  /** The alternate screen has no scrollback, so rows there are viewport rows. */
  private scrollbackLength(): number {
    const wasm = this.term.wasmTerm;
    if (!wasm || wasm.isAlternateScreen()) return 0;
    return wasm.getScrollbackLength();
  }

  private terminalCanvas(): HTMLCanvasElement | null {
    return this.container.querySelector('canvas:not([data-kitty])');
  }

  private tick = (): void => {
    requestAnimationFrame(this.tick);
    if (this.placements.size === 0 && !this.overlay.width) return;
    const canvas = this.terminalCanvas();
    if (!canvas) return;
    const cell = this.cell();
    const signature = [
      this.scrollbackLength(),
      this.term.viewportY,
      cell.width,
      cell.height,
      canvas.offsetLeft,
      canvas.offsetTop,
      canvas.offsetWidth,
      canvas.offsetHeight,
      window.devicePixelRatio,
    ].join('|');
    if (!this.dirty && signature === this.lastSignature) return;
    this.dirty = false;
    this.lastSignature = signature;
    this.draw(canvas, cell);
  };

  private draw(canvas: HTMLCanvasElement, cell: { width: number; height: number }): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    const o = this.overlay;
    if (o.width !== Math.round(w * dpr) || o.height !== Math.round(h * dpr)) {
      o.width = Math.round(w * dpr);
      o.height = Math.round(h * dpr);
    }
    o.style.left = `${canvas.offsetLeft}px`;
    o.style.top = `${canvas.offsetTop}px`;
    o.style.width = `${w}px`;
    o.style.height = `${h}px`;

    const ctx = o.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const topRow = this.scrollbackLength() - this.term.viewportY;
    for (const p of this.placements.values()) {
      const img = this.images.get(p.imageId)?.bitmap;
      if (!img) continue;
      const sx = p.srcX;
      const sy = p.srcY;
      const sw = p.srcW || img.width - sx;
      const sh = p.srcH || img.height - sy;
      const span =
        p.cols !== undefined || p.rows !== undefined
          ? cellSpan(
              { c: String(p.cols ?? 0), r: String(p.rows ?? 0) },
              { width: sw / p.scale.x, height: sh / p.scale.y },
              cell.width,
              cell.height,
            )
          : null;
      const dw = span ? span.cols * cell.width : sw / p.scale.x;
      const dh = span ? span.rows * cell.height : sh / p.scale.y;
      const x = p.col * cell.width + p.offX / p.scale.x;
      const y = (p.absRow - topRow) * cell.height + p.offY / p.scale.y;
      if (y + dh < 0 || y > h || x + dw < 0 || x > w) continue;
      ctx.drawImage(img, sx, sy, sw, sh, x, y, dw, dh);
    }
  }
}
