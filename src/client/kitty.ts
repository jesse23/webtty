// Pure (DOM-free) half of the kitty graphics protocol support: splitting APC
// sequences out of the PTY stream, parsing them, and building replies. The
// browser half (decode, placements, overlay canvas) is in graphics.ts.
// See ADR 032.

const ESC = '\x1b';

// A single APC is one chunk of at most 4096 base64 bytes per the spec, but
// nothing stops a client sending one huge sequence. Bound what we buffer.
const MAX_APC_BYTES = 64 * 1024 * 1024;

export type Segment = { type: 'text'; text: string } | { type: 'apc'; body: string };

/**
 * Splits a PTY stream into plain text and APC sequences (`ESC _ ... ESC \`).
 *
 * State survives across `feed()` calls: a WebSocket frame can end anywhere,
 * including between the `ESC` and `_` that open an APC, or between the `ESC`
 * and `\` that close it. A lone trailing `ESC` is therefore held back until
 * the next chunk says what it starts.
 */
export class ApcSplitter {
  private state: 'text' | 'esc' | 'apc' | 'apc-esc' = 'text';
  private parts: string[] = [];
  private size = 0;
  private overflow = false;

  feed(data: string): Segment[] {
    const out: Segment[] = [];
    let text = '';
    let i = 0;
    while (i < data.length) {
      if (this.state === 'text') {
        const esc = data.indexOf(ESC, i);
        if (esc < 0) {
          text += data.slice(i);
          break;
        }
        text += data.slice(i, esc);
        i = esc + 1;
        this.state = 'esc';
      } else if (this.state === 'esc') {
        if (data[i] === '_') {
          if (text) out.push({ type: 'text', text });
          text = '';
          this.begin();
          i++;
        } else {
          // Not an APC: give the held ESC back and reprocess this char.
          text += ESC;
          this.state = 'text';
        }
      } else if (this.state === 'apc') {
        const esc = data.indexOf(ESC, i);
        const end = esc < 0 ? data.length : esc;
        this.append(data.slice(i, end));
        i = end;
        if (esc >= 0) {
          this.state = 'apc-esc';
          i++;
        }
      } else if (data[i] === '\\') {
        // apc-esc: ESC \ closes the sequence.
        if (!this.overflow) out.push({ type: 'apc', body: this.parts.join('') });
        this.reset();
        i++;
      } else {
        // ESC not followed by `\` inside an APC: malformed. Drop the APC and
        // treat the ESC as the start of a fresh sequence.
        this.reset();
        this.state = 'esc';
      }
    }
    if (text) out.push({ type: 'text', text });
    return out;
  }

  private begin(): void {
    this.state = 'apc';
    this.parts = [];
    this.size = 0;
    this.overflow = false;
  }

  private append(s: string): void {
    if (this.overflow || !s) return;
    this.size += s.length;
    if (this.size > MAX_APC_BYTES) {
      this.overflow = true;
      this.parts = [];
      return;
    }
    this.parts.push(s);
  }

  private reset(): void {
    this.state = 'text';
    this.parts = [];
    this.size = 0;
    this.overflow = false;
  }
}

export type KittyKeys = Record<string, string>;

export interface KittyCommand {
  keys: KittyKeys;
  payload: string;
}

/** Parses an APC body (`G<k=v,k=v>;<payload>`). Returns null if it is not graphics. */
export function parseKittyApc(body: string): KittyCommand | null {
  if (body[0] !== 'G') return null;
  const semi = body.indexOf(';');
  const control = semi < 0 ? body.slice(1) : body.slice(1, semi);
  const payload = semi < 0 ? '' : body.slice(semi + 1);
  const keys: KittyKeys = {};
  for (const pair of control.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { keys, payload };
}

export interface Transmission {
  keys: KittyKeys;
  data: string;
}

/**
 * Reassembles chunked transmissions. The first chunk carries every key; the
 * following ones carry only `m` (and optionally `q`). `m=1` means more
 * follows, `m=0` or absent ends it.
 */
export class ChunkAssembler {
  private pending: { keys: KittyKeys; parts: string[] } | null = null;

  push(cmd: KittyCommand): Transmission | null {
    const more = cmd.keys.m === '1';
    if (!this.pending) {
      if (!more) return { keys: cmd.keys, data: cmd.payload };
      this.pending = { keys: cmd.keys, parts: [cmd.payload] };
      return null;
    }
    this.pending.parts.push(cmd.payload);
    if (more) return null;
    const done = { keys: this.pending.keys, data: this.pending.parts.join('') };
    this.pending = null;
    return done;
  }
}

/** Numeric key value, or `fallback` if absent / not a number. */
export function num(keys: KittyKeys, key: string, fallback = 0): number {
  const v = Number(keys[key]);
  return keys[key] !== undefined && Number.isFinite(v) ? v : fallback;
}

/**
 * Builds the reply for a command, or null when none must be sent: a command
 * without an image id/number gets no reply, `q=1` suppresses OK replies and
 * `q=2` suppresses everything.
 */
export function kittyReply(
  keys: KittyKeys,
  imageId: number,
  error?: { code: string; message: string },
): string | null {
  if (keys.i === undefined && keys.I === undefined) return null;
  const q = num(keys, 'q');
  if (q === 2 || (q === 1 && !error)) return null;
  const ids = [`i=${imageId}`];
  if (keys.I !== undefined) ids.push(`I=${keys.I}`);
  if (keys.p !== undefined) ids.push(`p=${keys.p}`);
  const status = error ? `${error.code}:${error.message}` : 'OK';
  return `${ESC}_G${ids.join(',')};${status}${ESC}\\`;
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
  if (bin.slice(1, 4) !== 'PNG') return null;
  const u32 = (o: number): number =>
    ((bin.charCodeAt(o) << 24) |
      (bin.charCodeAt(o + 1) << 16) |
      (bin.charCodeAt(o + 2) << 8) |
      bin.charCodeAt(o + 3)) >>>
    0;
  return { width: u32(16), height: u32(20) };
}

// Sequences after which any placed image no longer corresponds to what is on
// screen: erase display (2 = screen, 3 = screen + scrollback), alternate
// screen switches, and full reset. The emulator cannot tell us about overwrites,
// so these are the only points where placements are dropped implicitly.
const CLEARS_PLACEMENTS = new RegExp(`${ESC}\\[[23]J|${ESC}\\[\\?(?:1049|1047|47)[hl]|${ESC}c`);

export function clearsPlacements(text: string): boolean {
  return CLEARS_PLACEMENTS.test(text);
}

const SIZE_QUERY = new RegExp(`${ESC}\\[(14|16|18)t`, 'g');

/** Window-op size queries (`CSI 14 t`, `16 t`, `18 t`) present in `text`, in order. */
export function sizeQueries(text: string): number[] {
  const found: number[] = [];
  SIZE_QUERY.lastIndex = 0;
  for (let m = SIZE_QUERY.exec(text); m !== null; m = SIZE_QUERY.exec(text)) {
    found.push(Number(m[1]));
  }
  return found;
}

/**
 * A cell's size in whole device pixels. Reported to programs (CSI 16t) and used
 * by them to size frames as cols x this, so it has to be an integer even though
 * the CSS cell size (and devicePixelRatio, e.g. 1.25 or 1.5 on Windows) is not.
 */
export function deviceCellSize(cssCell: number, dpr: number): number {
  return Math.max(1, Math.round(cssCell * dpr));
}

/**
 * Device pixels per CSS pixel along one axis, derived from the whole-pixel cell
 * size rather than from devicePixelRatio directly. A frame of `cols` cells is
 * `cols * deviceCellSize` pixels wide; dividing by this scale draws it exactly
 * `cols * cssCell` CSS pixels wide, however the rounding fell. Dividing by the
 * raw devicePixelRatio would drift by up to half a pixel per column, which
 * leaves the image off the terminal grid at fractional scales.
 */
export function axisScale(cssCell: number, dpr: number): number {
  return cssCell > 0 ? deviceCellSize(cssCell, dpr) / cssCell : dpr;
}

export interface TerminalSize {
  cols: number;
  rows: number;
  /** Cell size in pixels. */
  cellWidth: number;
  cellHeight: number;
}

/** Reply to a `CSI <query> t` window-op size query. */
export function sizeReply(query: number, size: TerminalSize): string {
  const w = Math.round(size.cols * size.cellWidth);
  const h = Math.round(size.rows * size.cellHeight);
  if (query === 14) return `${ESC}[4;${h};${w}t`;
  if (query === 16) return `${ESC}[6;${Math.round(size.cellHeight)};${Math.round(size.cellWidth)}t`;
  return `${ESC}[8;${size.rows};${size.cols}t`;
}

export interface CellSpan {
  cols: number;
  rows: number;
}

/**
 * How many cells an image covers. `c` / `r` win when given; when only one is
 * given the other follows from the image's aspect ratio; with neither, the
 * image is shown at natural size.
 */
export function cellSpan(
  keys: KittyKeys,
  image: { width: number; height: number },
  cellWidth: number,
  cellHeight: number,
): CellSpan {
  const c = num(keys, 'c');
  const r = num(keys, 'r');
  const sw = num(keys, 'w') || image.width;
  const sh = num(keys, 'h') || image.height;
  if (c && r) return { cols: c, rows: r };
  if (c)
    return { cols: c, rows: Math.max(1, Math.ceil(((c * cellWidth) / sw) * (sh / cellHeight))) };
  if (r)
    return { cols: Math.max(1, Math.ceil(((r * cellHeight) / sh) * (sw / cellWidth))), rows: r };
  return {
    cols: Math.max(1, Math.ceil(sw / cellWidth)),
    rows: Math.max(1, Math.ceil(sh / cellHeight)),
  };
}
