import type { Terminal } from 'ghostty-web';
import {
  ApcSplitter,
  axisScale,
  ChunkAssembler,
  cellSpan,
  clearsPlacements,
  deviceCellSize,
  type KittyKeys,
  kittyReply,
  num,
  parseKittyApc,
  pngSize,
  sizeQueries,
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

const MAX_IMAGES = 256;

// Kitty image numbers (`I=`) are per-client handles the terminal maps to ids.
// Give them ids far above anything a client picks itself.
const IMAGE_NUMBER_BASE = 0x40000000;

interface StoredImage {
  bitmap?: ImageBitmap;
  // Decodes can finish out of order when frames arrive faster than they
  // decode; only the newest transmission may replace the bitmap.
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

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  // The protocol's `o=z` is zlib-wrapped deflate, which the web API calls 'deflate'.
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decode(keys: KittyKeys, data: string): Promise<ImageBitmap> {
  let bytes = base64ToBytes(data);
  if (keys.o === 'z') bytes = await inflate(bytes);
  const format = num(keys, 'f', 32);
  if (format === 100) {
    return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  }
  const width = num(keys, 's');
  const height = num(keys, 'v');
  if (!width || !height) throw new KittyError('EINVAL', 'raw image needs s and v');
  if (format !== 24 && format !== 32)
    throw new KittyError('EINVAL', `unsupported format f=${format}`);
  const bpp = format === 24 ? 3 : 4;
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
  private splitter = new ApcSplitter();
  private assembler = new ChunkAssembler();
  private images = new Map<number, StoredImage>();
  private placements = new Map<string, Placement>();
  private anonymousId = 0;
  private overlay: HTMLCanvasElement;
  private dirty = false;
  private lastSignature = '';

  constructor(
    private term: Terminal,
    private container: HTMLElement,
    /** Sends bytes to the PTY as if typed: replies to queries go here. */
    private send: (data: string) => void,
  ) {
    this.overlay = document.createElement('canvas');
    this.overlay.dataset.kitty = '';
    this.overlay.style.cssText = 'position:absolute;pointer-events:none;';
    container.appendChild(this.overlay);
    requestAnimationFrame(this.tick);
  }

  /**
   * Forget in-flight parse state and placements. Call when the PTY stream
   * restarts (WebSocket reconnect): a connection can drop mid-APC, and the
   * scrollback replay that follows would otherwise be swallowed as payload.
   */
  reset(): void {
    this.splitter = new ApcSplitter();
    this.assembler = new ChunkAssembler();
    this.clear();
  }

  /** Writes PTY output to the terminal, intercepting graphics commands. */
  feed(data: string): void {
    for (const seg of this.splitter.feed(data)) {
      if (seg.type === 'text') this.writeText(seg.text);
      else this.handleApc(seg.body);
    }
  }

  private writeText(text: string): void {
    this.term.write(text);
    if (clearsPlacements(text)) this.clear();
    for (const q of sizeQueries(text)) this.send(sizeReply(q, this.terminalSize()));
  }

  private handleApc(body: string): void {
    const cmd = parseKittyApc(body);
    if (!cmd) return;
    const tx = this.assembler.push(cmd);
    if (!tx) return;
    const action = tx.keys.a ?? 't';
    try {
      if (action === 'q') this.query(tx);
      else if (action === 't' || action === 'T') this.transmit(tx, action === 'T');
      else if (action === 'p') this.place(tx.keys, this.requireImageId(tx.keys));
      else if (action === 'd') this.delete(tx.keys);
    } catch (e) {
      this.replyError(tx.keys, e);
    }
  }

  private imageIdOf(keys: KittyKeys): number {
    if (keys.i !== undefined) return num(keys, 'i');
    if (keys.I !== undefined) return IMAGE_NUMBER_BASE + num(keys, 'I');
    return 0;
  }

  private requireImageId(keys: KittyKeys): number {
    const id = this.imageIdOf(keys);
    if (!this.images.get(id)?.bitmap) throw new KittyError('ENOENT', 'no such image');
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

  private transmit(tx: Transmission, display: boolean): void {
    this.assertSupported(tx.keys);
    const explicit = this.imageIdOf(tx.keys);
    const id = explicit || --this.anonymousId;

    // Re-sending an id replaces the image and drops its old placements.
    for (const [key, p] of this.placements) if (p.imageId === id) this.placements.delete(key);
    const slot = this.images.get(id) ?? { latest: 0, applied: 0 };
    this.images.delete(id); // re-insert so the Map stays ordered by recency
    this.images.set(id, slot);
    this.evict();
    const seq = ++slot.latest;

    // Placement is recorded now, before the decode finishes: the cursor must
    // move at this exact point in the stream, and the draw simply waits for
    // the bitmap.
    if (display) this.place(tx.keys, id, this.dimensions(tx));

    decode(tx.keys, tx.data).then(
      (bitmap) => {
        if (seq <= slot.applied || this.images.get(id) !== slot) {
          bitmap.close();
          return;
        }
        slot.bitmap?.close();
        slot.bitmap = bitmap;
        slot.applied = seq;
        this.dirty = true;
        this.reply(tx.keys, explicit ? id : 0);
      },
      (e) => this.replyError(tx.keys, e),
    );
  }

  /** Pixel size known synchronously from the command (raw `s`/`v` or PNG header). */
  private dimensions(tx: Transmission): { width: number; height: number } {
    if (num(tx.keys, 'f', 32) !== 100)
      return { width: num(tx.keys, 's'), height: num(tx.keys, 'v') };
    return (tx.keys.o !== 'z' && pngSize(tx.data)) || { width: 0, height: 0 };
  }

  private place(keys: KittyKeys, imageId: number, known?: { width: number; height: number }): void {
    const image = known ?? this.images.get(imageId)?.bitmap ?? { width: 0, height: 0 };
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
    if (num(keys, 'C') === 1 || !image.width || !image.height) return;
    const span = cellSpan(
      keys,
      { width: image.width / scale.x, height: image.height / scale.y },
      cell.width,
      cell.height,
    );
    this.term.write(`${'\n'.repeat(span.rows - 1)}\x1b[${p.col + span.cols + 1}G`);
  }

  private delete(keys: KittyKeys): void {
    const target = keys.d ?? 'a';
    if (target === 'a' || target === 'A') {
      this.placements.clear();
      if (target === 'A') this.dropImages();
    } else if (target === 'i' || target === 'I') {
      const id = this.imageIdOf(keys);
      const pid = keys.p !== undefined ? num(keys, 'p') : undefined;
      for (const [key, p] of this.placements) {
        if (p.imageId === id && (pid === undefined || p.placementId === pid)) {
          this.placements.delete(key);
        }
      }
      if (target === 'I') this.dropImage(id);
    }
    this.dirty = true;
  }

  private dropImage(id: number): void {
    this.images.get(id)?.bitmap?.close();
    this.images.delete(id);
  }

  private dropImages(): void {
    for (const id of [...this.images.keys()]) this.dropImage(id);
  }

  /** Placements no longer match what is on screen. Image data is kept: clients may re-place it. */
  private clear(): void {
    if (this.placements.size === 0) return;
    this.placements.clear();
    this.dirty = true;
  }

  private evict(): void {
    while (this.images.size > MAX_IMAGES) {
      const oldest = this.images.keys().next().value as number;
      for (const [key, p] of this.placements) if (p.imageId === oldest) this.placements.delete(key);
      this.dropImage(oldest);
    }
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
