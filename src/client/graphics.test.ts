import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { KittyGraphics, type Limits } from './graphics';
import { deviceCellSize } from './kitty';

// KittyGraphics needs a DOM, a canvas and image decoding. These tests stub just
// enough of them to drive its state handling: what is placed, what is answered,
// and what is freed. Drawing is not exercised.

const ESC = '\x1b';
const apc = (keys: string, payload = ''): string => `${ESC}_G${keys};${payload}${ESC}\\`;
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const zeros = (n: number): string => b64(new Uint8Array(n));

// A PNG file is only inspected for its IHDR before the decode is handed to the
// (stubbed) browser, so a header is enough.
function pngHeader(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

let bitmaps: FakeBitmap[] = [];
let listeners = new Map<string, () => void>();
let visibility = 'visible';
let gate: Promise<void> | null = null;
// Gates for the next decodes, in the order they start: lets a test finish them in any order.
let gates: Array<Promise<void>> = [];
const hold = (): (() => void) => {
  let release = () => {};
  gates.push(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  return release;
};
const saved: Record<string, unknown> = {};

function makeBitmap(width: number, height: number): FakeBitmap {
  const bitmap: FakeBitmap = {
    width,
    height,
    closed: false,
    close() {
      this.closed = true;
    },
  };
  bitmaps.push(bitmap);
  return bitmap;
}

beforeEach(() => {
  bitmaps = [];
  gate = null;
  gates = [];
  listeners = new Map();
  visibility = 'visible';
  const g = globalThis as Record<string, unknown>;
  for (const key of [
    'document',
    'window',
    'requestAnimationFrame',
    'createImageBitmap',
    'ImageData',
  ]) {
    saved[key] = g[key];
  }
  g.document = {
    addEventListener: (type: string, cb: () => void) => listeners.set(type, cb),
    get visibilityState() {
      return visibility;
    },
    createElement: () => ({ dataset: {}, style: {}, width: 0, height: 0, getContext: () => null }),
  };
  g.window = { devicePixelRatio: 1 };
  g.requestAnimationFrame = () => 0;
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  g.createImageBitmap = async (src: { width?: number; height?: number } | Blob) => {
    if (gate) await gate;
    const own = gates.shift();
    if (own) await own;
    if (src instanceof Blob) {
      const head = new Uint8Array(await src.arrayBuffer());
      const view = new DataView(head.buffer, head.byteOffset);
      return makeBitmap(view.getUint32(16), view.getUint32(20));
    }
    return makeBitmap(src.width ?? 0, src.height ?? 0);
  };
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) g[key] = value;
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

interface Harness {
  g: KittyGraphics;
  written: string[];
  sent: string[];
  cursor: { x: number; y: number };
  placements: () => Map<string, unknown>;
  images: () => Map<number, { bitmap?: FakeBitmap }>;
  dirty: () => boolean;
  clearDirty: () => void;
}

function harness(
  limits: Partial<Limits> = {},
  cell: { width: number; height: number } = { width: 10, height: 20 },
): Harness {
  const written: string[] = [];
  const sent: string[] = [];
  const cursor = { x: 2, y: 3 };
  const term = {
    cols: 80,
    rows: 24,
    viewportY: 0,
    write: (s: string) => written.push(s),
    buffer: {
      active: {
        get cursorX() {
          return cursor.x;
        },
        get cursorY() {
          return cursor.y;
        },
      },
    },
    wasmTerm: { isAlternateScreen: () => false, getScrollbackLength: () => 0 },
    renderer: { getMetrics: () => cell },
  };
  const container = { appendChild: () => {}, querySelector: () => null };
  const g = new KittyGraphics(term as never, container as never, (d) => sent.push(d), limits);
  const internals = g as unknown as {
    placements: Map<string, unknown>;
    images: Map<number, { bitmap?: FakeBitmap }>;
    dirty: boolean;
  };
  return {
    g,
    written,
    sent,
    cursor,
    placements: () => internals.placements,
    images: () => internals.images,
    dirty: () => internals.dirty,
    clearDirty: () => {
      internals.dirty = false;
    },
  };
}

describe('a=t followed by a=p', () => {
  test('in the same chunk keeps the placement instead of answering ENOENT', async () => {
    const h = harness();
    h.g.feed(apc('a=t,f=32,s=20,v=40,i=1', zeros(20 * 40 * 4)) + apc('a=p,i=1'));
    expect(h.placements().size).toBe(1);
    expect(h.sent.join('')).not.toContain('ENOENT');
    await flush();
    expect(h.images().get(1)?.bitmap).toBeDefined();
    // one OK for the placement, one for the transmission once it decoded
    expect(h.sent.filter((r) => r === `${ESC}_Gi=1;OK${ESC}\\`)).toHaveLength(2);
  });

  test('moves the cursor from the size known before the decode finishes', () => {
    const h = harness();
    // 20x40 px at 10x20 px cells = 2 columns, 2 rows, from cursor column 2
    h.g.feed(apc('a=t,f=32,s=20,v=40,i=1', zeros(20 * 40 * 4)) + apc('a=p,i=1'));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });

  test('a=p for an id never transmitted is ENOENT', () => {
    const h = harness();
    h.g.feed(apc('a=p,i=9'));
    expect(h.sent).toEqual([`${ESC}_Gi=9;ENOENT:no such image${ESC}\\`]);
    expect(h.placements().size).toBe(0);
  });

  test('q=1 silences the placement acknowledgement', async () => {
    const h = harness();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)) + apc('a=p,i=1,q=1'));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;OK${ESC}\\`]); // the transmission's, not the placement's
  });
});

describe('a=d', () => {
  test('removes placements, repaints, and sends no reply', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.sent.length = 0;
    h.clearDirty();
    h.g.feed(apc('a=d,d=i,i=1'));
    expect(h.placements().size).toBe(0);
    expect(h.dirty()).toBe(true);
    expect(h.sent).toEqual([]);
  });
});

describe('overlay invalidation', () => {
  test('replacing an image marks the overlay dirty even though it only removes placements', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.clearDirty();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    expect(h.placements().size).toBe(0);
    expect(h.dirty()).toBe(true);
  });

  test('a failed decode removes what it placed, drops the image, and repaints', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=10,v=10,i=1,C=1', zeros(8))); // far too little pixel data
    expect(h.placements().size).toBe(1);
    h.clearDirty();
    await flush();
    expect(h.placements().size).toBe(0);
    expect(h.images().size).toBe(0);
    expect(h.dirty()).toBe(true);
    expect(h.sent).toEqual([`${ESC}_Gi=1;ENODATA:not enough pixel data${ESC}\\`]);
  });

  test('a clear repaints even when no placement is left to remove', () => {
    const h = harness();
    h.clearDirty();
    h.g.feed(`${ESC}[2J`);
    expect(h.dirty()).toBe(true);
  });

  test('a failed re-transmission keeps the previous bitmap for a=p to re-place', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.g.feed(apc('a=T,f=32,s=10,v=10,i=1,C=1', zeros(8)));
    await flush();
    expect(h.placements().size).toBe(0);
    expect(h.images().get(1)?.bitmap).toBeDefined();
  });
});

describe('reconnect', () => {
  test('a decode that finishes after reset() neither installs its bitmap nor replies', async () => {
    const h = harness();
    let release = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.g.reset();
    release();
    await flush();
    expect(h.images().size).toBe(0);
    expect(h.placements().size).toBe(0);
    expect(h.sent).toEqual([]);
    expect(bitmaps.every((b) => b.closed)).toBe(true);
  });

  test('a decode error after reset() does not reply into the new stream either', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=10,v=10,i=1,C=1', zeros(8)));
    h.g.reset();
    await flush();
    expect(h.sent).toEqual([]);
  });

  test('images from the old stream are freed and cannot be placed by the new one', async () => {
    const h = harness();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    await flush();
    h.sent.length = 0;
    const old = bitmaps[0];
    h.g.reset();
    expect(old.closed).toBe(true);
    h.g.feed(apc('a=p,i=1'));
    expect(h.sent).toEqual([`${ESC}_Gi=1;ENOENT:no such image${ESC}\\`]);
  });

  test('the new stream may reuse an image id', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.g.reset();
    h.g.feed(apc('a=T,f=32,s=2,v=2,i=1,C=1', zeros(16)));
    await flush();
    expect(h.images().get(1)?.bitmap).toMatchObject({ width: 2, height: 2, closed: false });
  });
});

describe('memory limits', () => {
  test('raw dimensions over the pixel limit are rejected before anything is decoded', () => {
    const h = harness({ maxImagePixels: 100 });
    h.g.feed(apc('a=T,f=32,s=11,v=10,i=1,q=0', zeros(4)));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:image too large${ESC}\\`]);
    expect(h.images().size).toBe(0);
    expect(h.placements().size).toBe(0);
    expect(h.written).toEqual([]);
  });

  test('a PNG header over the limit is rejected up front', () => {
    const h = harness({ maxImagePixels: 100 });
    h.g.feed(apc('a=t,f=100,i=1', b64(pngHeader(11, 10))));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:image too large${ESC}\\`]);
  });

  test('a compressed PNG that inflates to a too-large image is rejected after inflating', async () => {
    const h = harness({ maxImagePixels: 100 });
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(11, 10)))));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:image too large${ESC}\\`]);
    expect(h.images().size).toBe(0);
  });

  test('a small zlib payload that expands past the expected size is cut off', async () => {
    const h = harness();
    h.g.feed(apc('a=t,f=32,s=2,v=2,o=z,i=1', b64(deflateSync(new Uint8Array(4 * 1024 * 1024)))));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:decompressed data too large${ESC}\\`]);
    expect(h.images().size).toBe(0);
  });

  test.each(['s=0,v=5', 's=-3,v=5', 's=2.5,v=5', 's=5'])(
    'invalid raw size %s is rejected',
    (dims) => {
      const h = harness();
      h.g.feed(apc(`a=t,f=32,${dims},i=1`, zeros(64)));
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toContain('EINVAL');
      expect(h.images().size).toBe(0);
    },
  );

  test('the total decoded size is a budget: the oldest images go first, the newest stays', async () => {
    // each 2x2 image is 16 bytes decoded and, while decoding, holds 40 (16 of
    // RGBA plus its 24-character payload): room for two stored plus one decoding
    const h = harness({ maxTotalBytes: 60 });
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=T,f=32,s=2,v=2,i=${id},C=1`, zeros(16)));
      await flush();
    }
    expect([...h.images().keys()]).toEqual([2, 3]);
    expect(bitmaps[0].closed).toBe(true);
    expect(bitmaps[2].closed).toBe(false);
    expect([...h.placements().keys()]).toEqual(['2:0', '3:0']);
  });

  test('the image count is capped and eviction removes the placements too', async () => {
    const h = harness({ maxImages: 2 });
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=T,f=32,s=1,v=1,i=${id},C=1`, zeros(4)));
      await flush();
    }
    expect([...h.images().keys()]).toEqual([2, 3]);
    expect([...h.placements().keys()]).toEqual(['2:0', '3:0']);
  });

  test('a chunked transmission over the size cap gets one error and its later chunks are ignored', async () => {
    const h = harness({ maxTransmissionBytes: 100 });
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1,m=1', 'A'.repeat(40)));
    h.g.feed(apc('m=1', 'A'.repeat(70))); // 110 > 100: dropped
    h.g.feed(apc('m=1', 'AAAA'));
    expect(h.sent).toEqual([]);
    h.g.feed(apc('m=0', 'AA'));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:transmission too large${ESC}\\`]);
    expect(h.images().size).toBe(0);
    // and nothing that follows is affected
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=2', zeros(4)));
    await flush();
    expect(h.images().get(2)?.bitmap).toBeDefined();
  });
});

describe('compressed PNG', () => {
  test('a=T without C=1 is rejected: the cursor cannot be moved without the size', () => {
    const h = harness();
    h.g.feed(apc('a=T,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('EINVAL');
    expect(h.sent[0]).toContain('C=1');
    expect(h.images().size).toBe(0);
    expect(h.placements().size).toBe(0);
    expect(h.written).toEqual([]);
  });

  test('a=T with C=1 is placed and decoded', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=100,o=z,i=1,C=1', b64(deflateSync(pngHeader(20, 40)))));
    expect(h.placements().size).toBe(1);
    await flush();
    expect(h.images().get(1)?.bitmap).toMatchObject({ width: 20, height: 40 });
  });

  test('a=t alone needs no size', async () => {
    const h = harness();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    await flush();
    expect(h.images().get(1)?.bitmap).toBeDefined();
    expect(h.sent).toEqual([`${ESC}_Gi=1;OK${ESC}\\`]);
  });

  test('a=p of it works once the decode has finished, using the decoded size', async () => {
    const h = harness();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    await flush();
    h.written.length = 0;
    h.g.feed(apc('a=p,i=1'));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });
});

describe('source rectangle and display scale', () => {
  test('w/h are converted like the image before the cursor is moved', () => {
    (globalThis as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 2;
    const h = harness();
    // cells are 10x20 CSS px = 20x40 device px. A 20x40 device-px region is one
    // cell; treating w/h as CSS px would advance two columns and two rows.
    h.g.feed(apc('a=T,f=32,s=100,v=100,w=20,h=40,i=1', zeros(100 * 100 * 4)));
    expect(h.written).toEqual([`${ESC}[4G`]);
  });

  test('without a source rectangle the whole image is used', () => {
    (globalThis as { window: { devicePixelRatio: number } }).window.devicePixelRatio = 2;
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=40,v=80,i=1', zeros(40 * 80 * 4)));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });

  test('x/y shrink the default region', () => {
    const h = harness();
    // 30x60 image, origin at 10,20: the visible 20x40 is 2 columns and 2 rows
    h.g.feed(apc('a=T,f=32,s=30,v=60,x=10,y=20,i=1', zeros(30 * 60 * 4)));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });
});

describe('sequences split across chunks', () => {
  test('a clear split over two feeds drops the placements', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    expect(h.placements().size).toBe(1);
    h.g.feed(`text${ESC}[`);
    expect(h.placements().size).toBe(1);
    h.g.feed('2Jmore');
    expect(h.placements().size).toBe(0);
  });

  test('a size query split over two feeds is answered', () => {
    const h = harness();
    h.g.feed(`${ESC}[1`);
    expect(h.sent).toEqual([]);
    h.g.feed('4t');
    // 80x24 cells of 10x20 px
    expect(h.sent).toEqual([`${ESC}[4;480;800t`]);
  });

  test('the text is still written to the terminal in the same pieces', () => {
    const h = harness();
    h.g.feed(`a${ESC}[`);
    h.g.feed('2Jb');
    expect(h.written.join('')).toBe(`a${ESC}[2Jb`);
  });
});

describe('cursor movement at scaled display', () => {
  // An image exactly cols x rows cells of the size the program was told must
  // leave the cursor exactly that many columns and rows on. Converting device
  // pixels back to CSS pixels adds a rounding error for some cell sizes, which a
  // plain ceil turned into one cell too many. These combinations are ones where
  // it happened: it depends on the values, so a single arbitrary size proves
  // nothing.
  test.each([
    { dpr: 1.25, cell: { width: 9.6, height: 20.4 }, cols: 7, rows: 3 },
    { dpr: 1.5, cell: { width: 8.4, height: 19.2 }, cols: 5, rows: 7 },
    { dpr: 2, cell: { width: 9.6, height: 20.4 }, cols: 7, rows: 3 },
    { dpr: 3, cell: { width: 9.6, height: 20.4 }, cols: 7, rows: 7 },
  ])(
    '$cols x $rows cells of $cell.width x $cell.height at dpr $dpr',
    ({ dpr, cell, cols, rows }) => {
      (globalThis as { window: { devicePixelRatio: number } }).window.devicePixelRatio = dpr;
      const h = harness({}, cell);
      const w = cols * deviceCellSize(cell.width, dpr);
      const hgt = rows * deviceCellSize(cell.height, dpr);
      h.g.feed(apc(`a=T,f=32,s=${w},v=${hgt},i=1`, zeros(w * hgt * 4)));
      // the cursor starts at column 2: rows - 1 line feeds, then column 2 + cols + 1
      expect(h.written).toEqual([`${'\n'.repeat(rows - 1)}${ESC}[${2 + cols + 1}G`]);
    },
  );
});

describe('an oversized sequence', () => {
  test('is answered with an error and none of its payload reaches the terminal', () => {
    const h = harness({ maxTransmissionBytes: 200 });
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', 'A'.repeat(300)));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:transmission too large${ESC}\\`]);
    expect(h.written).toEqual([]);
    expect(h.images().size).toBe(0);
  });

  test('the rest of a chunked transmission it started is ignored, with one error', () => {
    const h = harness({ maxTransmissionBytes: 200 });
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1,m=1', 'A'.repeat(300))); // the first chunk is itself too big
    h.g.feed(apc('m=1', 'AAAA'));
    expect(h.sent).toEqual([]);
    h.g.feed(apc('m=0', 'AA'));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:transmission too large${ESC}\\`]);
  });

  test('one that is never terminated is ended by CAN, and text resumes', () => {
    const h = harness({ maxTransmissionBytes: 100 });
    h.g.feed(`${ESC}_Ga=t,i=1;${'A'.repeat(300)}`);
    h.g.feed('still payload');
    expect(h.written).toEqual([]);
    h.g.feed('\x18text again');
    expect(h.written).toEqual(['text again']);
  });
});

describe('decodes in flight', () => {
  test('count against the memory budget, so a flood of transmissions is refused', async () => {
    // each 2x2 image holds 40 while decoding: 16 of RGBA and a 24-character payload
    const h = harness({ maxTotalBytes: 100 });
    const release = [hold(), hold()];
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=1', zeros(16)) + apc('a=t,f=32,s=2,v=2,i=2', zeros(16)));
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=3', zeros(16)));
    expect(h.sent).toEqual([`${ESC}_Gi=3;EINVAL:too many images being decoded${ESC}\\`]);
    expect(h.images().has(3)).toBe(false);
    for (const r of release) r();
    await flush();
    h.sent.length = 0;
    // the reservations were released, so there is room again
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=4', zeros(16)));
    await flush();
    expect(h.images().get(4)?.bitmap).toBeDefined();
  });

  test('a compressed PNG, whose size is unknown until decoded, reserves the worst case', async () => {
    // worst case: 100 pixels of RGBA (400 bytes) plus the payload
    const h = harness({ maxImagePixels: 100, maxTotalBytes: 500 });
    const release = hold();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(2, 2)))));
    h.g.feed(apc('a=t,f=100,o=z,i=2', b64(deflateSync(pngHeader(2, 2)))));
    expect(h.sent).toEqual([`${ESC}_Gi=2;EINVAL:too many images being decoded${ESC}\\`]);
    release();
    await flush();
  });

  test('a failed decode releases its reservation', async () => {
    const h = harness({ maxTotalBytes: 500 });
    const tooLittle = () => h.g.feed(apc('a=t,f=32,s=10,v=10,i=1', zeros(8))); // reserves 412
    tooLittle();
    await flush();
    h.sent.length = 0;
    tooLittle(); // refused if the first still held its 412
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;ENODATA:not enough pixel data${ESC}\\`]);
  });

  test('stored images are dropped, oldest first, to make room for a new one', async () => {
    const h = harness({ maxTotalBytes: 60 });
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=t,f=32,s=2,v=2,i=${id}`, zeros(16)));
      await flush();
    }
    expect([...h.images().keys()]).toEqual([2, 3]);
  });
});

describe('every transmission is answered', () => {
  test('one removed while it decodes gets an error instead of silence', async () => {
    const h = harness({ maxImages: 1 });
    const releases = [hold(), hold()];
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=2', zeros(4))); // evicts image 1 while it is still decoding
    for (const r of releases) r();
    await flush();
    expect(h.sent).toContain(
      `${ESC}_Gi=1;EINVAL:image was removed before it finished decoding${ESC}\\`,
    );
    expect(h.sent).toContain(`${ESC}_Gi=2;OK${ESC}\\`);
    expect(h.images().has(1)).toBe(false);
    expect(bitmaps[0].closed).toBe(true);
  });

  test('one deleted while it decodes gets the same error', async () => {
    const h = harness();
    const release = hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.feed(apc('a=d,d=I,i=1'));
    release();
    await flush();
    expect(h.sent).toEqual([
      `${ESC}_Gi=1;EINVAL:image was removed before it finished decoding${ESC}\\`,
    ]);
  });

  test('one superseded by a newer transmission that already finished still gets its OK', async () => {
    const h = harness();
    const releaseOld = hold();
    const releaseNew = hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=1', zeros(16))); // replaces it
    releaseNew();
    await flush();
    expect(h.images().get(1)?.bitmap).toMatchObject({ width: 2 });
    releaseOld();
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;OK${ESC}\\`, `${ESC}_Gi=1;OK${ESC}\\`]);
    expect(bitmaps.find((b) => b.width === 1)?.closed).toBe(true);
    expect(h.images().get(1)?.bitmap).toMatchObject({ width: 2, closed: false });
  });

  test('an older transmission that finishes first is shown until the newer one is ready', async () => {
    const h = harness();
    const releaseOld = hold();
    const releaseNew = hold();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.g.feed(apc('a=T,f=32,s=2,v=2,i=1,C=1', zeros(16)));
    releaseOld();
    await flush();
    // a stream of frames must not be blank while decoding lags behind it
    expect(h.images().get(1)?.bitmap).toMatchObject({ width: 1 });
    releaseNew();
    await flush();
    expect(h.images().get(1)?.bitmap).toMatchObject({ width: 2 });
    expect(bitmaps[0].closed).toBe(true);
  });

  test('a stream reset answers nothing for decodes that were running', async () => {
    const h = harness();
    const release = hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.reset();
    release();
    await flush();
    expect(h.sent).toEqual([]);
  });
});

describe('placements are sized from the current transmission', () => {
  test('a=p of a compressed PNG replacing a decoded image does not borrow the old bitmap size', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=20,v=40,i=1,C=1', zeros(20 * 40 * 4)));
    await flush();
    const release = hold();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    h.sent.length = 0;
    h.written.length = 0;
    h.g.feed(apc('a=p,i=1'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('C=1');
    expect(h.written).toEqual([]);
    release();
    await flush();
  });

  test('a=p of a resized image moves the cursor by the new size, not the old bitmap', async () => {
    const h = harness();
    h.g.feed(apc('a=T,f=32,s=10,v=20,i=1,C=1', zeros(10 * 20 * 4))); // one cell
    await flush();
    const release = hold();
    h.g.feed(apc('a=t,f=32,s=40,v=40,i=1', zeros(40 * 40 * 4))); // 4 columns, 2 rows
    h.written.length = 0;
    h.g.feed(apc('a=p,i=1'));
    expect(h.written).toEqual([`\n${ESC}[7G`]); // column 2 + 4 + 1
    release();
    await flush();
  });
});

describe('eviction order', () => {
  test('enforcing the budget keeps the newest transmission, whichever decode finished last', async () => {
    const h = harness();
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=t,f=32,s=2,v=2,i=${id}`, zeros(16)));
      await flush();
    }
    const internals = h.g as unknown as { limits: Limits; enforceBudget(): boolean };
    internals.limits.maxTotalBytes = 20;
    internals.enforceBudget();
    expect([...h.images().keys()]).toEqual([3]);
  });
});

describe('overlay repaint when the tab is shown again', () => {
  test('a tab coming back to the foreground repaints the overlay', () => {
    const h = harness();
    h.clearDirty();
    visibility = 'hidden';
    listeners.get('visibilitychange')?.();
    expect(h.dirty()).toBe(false);
    visibility = 'visible';
    listeners.get('visibilitychange')?.();
    expect(h.dirty()).toBe(true);
  });

  test('invalidate() forces a repaint even when nothing about the geometry changed', () => {
    const h = harness();
    (h.g as unknown as { lastSignature: string }).lastSignature = 'same';
    h.clearDirty();
    h.g.invalidate();
    expect(h.dirty()).toBe(true);
    expect((h.g as unknown as { lastSignature: string }).lastSignature).toBe('');
  });
});

describe('a header that only looks like a PNG', () => {
  test.each([
    ['signature', (b: Uint8Array) => (b[0] = 0x00)],
    ['IHDR length', (b: Uint8Array) => (b[11] = 12)],
    ['IHDR type', (b: Uint8Array) => (b[15] = 0x58)],
  ])('with a bad %s is refused before the cursor moves', (_name, corrupt) => {
    const h = harness();
    const bad = pngHeader(20, 40);
    corrupt(bad);
    h.g.feed(apc('a=T,f=100,i=1', b64(bad)));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:not a PNG${ESC}\\`]);
    expect(h.written).toEqual([]);
    expect(h.placements().size).toBe(0);
    expect(h.images().size).toBe(0);
  });
});
