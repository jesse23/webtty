// Drives KittyGraphics on fakes (test fake, ADR 064): a terminal that records what is
// written, a decoder whose bitmaps the test releases in any order, and an injected
// happy-dom container whose overlay frames the test steps with a manual clock.

import { createDomWindow, type DomWindow } from '../../../../test-support/dom-window';
import { ManualClock } from '../../../../test-support/manual-clock';
import type { ImageDecoderDeps } from '../image-decoder';
import { KittyGraphics } from '../kitty-graphics';
import type { KittyLimits } from '../kitty-limits';
import type { KittyTerminal } from '../kitty-terminal';

/** The escape character, for building sequences in expectations. */
export const ESC = '\x1b';
/** A kitty graphics APC with control keys and an optional base64 payload. */
export const apc = (keys: string, payload = ''): string => `${ESC}_G${keys};${payload}${ESC}\\`;
/** Base64 of `bytes`, as a transmission carries them. */
export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
/** A base64 payload of `n` zero bytes. */
export const zeros = (n: number): string => b64(new Uint8Array(n));
/** Lets pending decodes settle: the inflate stream needs real ticks, not just microtasks. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/**
 * The first 33 bytes of a PNG file: signature and IHDR. A PNG is only inspected for its
 * IHDR before the decode is handed to the (fake) browser, so a header is enough.
 */
export function pngHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/** An ImageBitmap stand-in that records whether it was closed. */
export interface FakeBitmap extends ImageBitmap {
  closed: boolean;
}

/** Makes a fake bitmap of the given size. */
export function fakeBitmap(width: number, height: number): FakeBitmap {
  return {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

/**
 * The browser's image constructors, faked: every bitmap made is kept in `bitmaps`, and
 * `hold()` makes the next decode wait until the test releases it.
 */
export class FakeDecoder implements ImageDecoderDeps {
  readonly bitmaps: FakeBitmap[] = [];
  /** The RGBA of every raw image decoded, as plain numbers. */
  readonly pixels: number[][] = [];
  private readonly gates: Array<Promise<void>> = [];

  /** Gates the next decode to start; returns the call that lets it finish. */
  hold(): () => void {
    let release = () => {};
    this.gates.push(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    return release;
  }

  readonly createImageBitmap = async (source: ImageBitmapSource): Promise<ImageBitmap> => {
    const gate = this.gates.shift();
    if (gate) await gate;
    let size: { width: number; height: number };
    if (source instanceof Blob) {
      const head = new DataView(await source.arrayBuffer());
      size = { width: head.getUint32(16), height: head.getUint32(20) };
    } else {
      size = source as ImageData;
    }
    const bitmap = fakeBitmap(size.width, size.height);
    this.bitmaps.push(bitmap);
    return bitmap;
  };

  readonly createImageData = (
    data: Uint8ClampedArray<ArrayBuffer>,
    width: number,
    height: number,
  ): ImageData => {
    this.pixels.push([...data]);
    return { data, width, height, colorSpace: 'srgb' };
  };
}

/** What a harness test drives and inspects. */
export interface GraphicsHarness {
  g: KittyGraphics;
  /** Everything written to the terminal, one entry per write. */
  written: string[];
  /** Every reply sent to the PTY. */
  sent: string[];
  cursor: { x: number; y: number };
  decoder: FakeDecoder;
  clock: ManualClock;
  dom: DomWindow;
  win: { devicePixelRatio: number };
  /** The overlay canvas. */
  overlay: HTMLCanvasElement;
  /** Layout reads made of the terminal's canvas, and repaints (clearRect calls) of the overlay. */
  counts: { reads: number; repaints: number; drawn: number };
}

let open: DomWindow[] = [];

/** Closes every harness window; call it from `afterEach`. */
export async function closeHarnesses(): Promise<void> {
  const windows = open;
  open = [];
  await Promise.all(windows.map((w) => w.close()));
}

/** Defines a counted layout property on the terminal's canvas. */
function countedLayout(el: HTMLElement, counts: { reads: number }): void {
  const box = { offsetLeft: 0, offsetTop: 0, offsetWidth: 800, offsetHeight: 600 };
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(el, key, {
      get: () => {
        counts.reads++;
        return value;
      },
    });
  }
}

/** A KittyGraphics over 10x20 px cells (by default) with its cursor at column 2, row 3. */
export function graphicsHarness(
  limits: Partial<KittyLimits> = {},
  cell: { width: number; height: number } = { width: 10, height: 20 },
): GraphicsHarness {
  const written: string[] = [];
  const sent: string[] = [];
  const cursor = { x: 2, y: 3 };
  const term: KittyTerminal = {
    viewportY: 0,
    write: (s: string) => written.push(s),
    buffer: { active: activeOf(cursor) },
    wasmTerm: { isAlternateScreen: () => false, getScrollbackLength: () => 0 },
    renderer: { getMetrics: () => cell, scrollOffset: 0 },
  };
  const dom = createDomWindow();
  open.push(dom);
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const counts = { reads: 0, repaints: 0, drawn: 0 };
  const terminalCanvas = dom.document.createElement('canvas');
  countedLayout(terminalCanvas, counts);
  container.append(terminalCanvas);
  const clock = new ManualClock();
  const decoder = new FakeDecoder();
  const win = {
    devicePixelRatio: 1,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
  };
  const g = new KittyGraphics(term, container, (d) => sent.push(d), limits, {
    document: dom.document,
    window: win,
    decoder,
  });
  const overlay = container.querySelector('canvas[data-kitty]') as HTMLCanvasElement;
  const ctx = {
    setTransform() {},
    clearRect: () => counts.repaints++,
    drawImage: () => counts.drawn++,
  };
  Object.defineProperty(overlay, 'getContext', { value: () => ctx });
  return { g, written, sent, cursor, decoder, clock, dom, win, overlay, counts };
}

function activeOf(cursor: { x: number; y: number }): { cursorX: number; cursorY: number } {
  return {
    get cursorX() {
      return cursor.x;
    },
    get cursorY() {
      return cursor.y;
    },
  };
}
