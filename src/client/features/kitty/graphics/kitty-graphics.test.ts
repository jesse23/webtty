import { afterEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { deviceCellSize } from '../protocol/cell-geometry';
import {
  apc,
  b64,
  closeHarnesses,
  ESC,
  flush,
  graphicsHarness,
  pngHeader,
  zeros,
} from './test-support/graphics-harness';

// KittyGraphics against a fake terminal, a fake decoder and a happy-dom container: what is
// placed, what is answered, what is freed, and when the overlay repaints. The parts have
// their own tests; these pin the protocol behaviour the facade composes from them.

afterEach(closeHarnesses);

describe('a=t followed by a=p', () => {
  test('in the same chunk keeps the placement instead of answering ENOENT', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=t,f=32,s=20,v=40,i=1', zeros(20 * 40 * 4)) + apc('a=p,i=1'));
    expect(h.g.placements.size).toBe(1);
    expect(h.sent.join('')).not.toContain('ENOENT');
    await flush();
    expect(h.g.images.get(1)?.bitmap).toBeDefined();
    // one OK for the placement, one for the transmission once it decoded
    expect(h.sent.filter((r) => r === `${ESC}_Gi=1;OK${ESC}\\`)).toHaveLength(2);
  });

  test('moves the cursor from the size known before the decode finishes', () => {
    const h = graphicsHarness();
    // 20x40 px at 10x20 px cells = 2 columns, 2 rows, from cursor column 2
    h.g.feed(apc('a=t,f=32,s=20,v=40,i=1', zeros(20 * 40 * 4)) + apc('a=p,i=1'));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });

  test('a=p for an id never transmitted is ENOENT', () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=p,i=9'));
    expect(h.sent).toEqual([`${ESC}_Gi=9;ENOENT:no such image${ESC}\\`]);
    expect(h.g.placements.size).toBe(0);
  });

  test('q=1 silences the placement acknowledgement', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)) + apc('a=p,i=1,q=1'));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;OK${ESC}\\`]); // the transmission's, not the placement's
  });
});

describe('a=q', () => {
  test('answers OK for what it supports and an error for what it does not, storing nothing', () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=q,i=31,f=24,s=1,v=1', zeros(3)) + apc('a=q,i=32,t=f', zeros(3)));
    expect(h.sent).toEqual([
      `${ESC}_Gi=31;OK${ESC}\\`,
      `${ESC}_Gi=32;EINVAL:unsupported transmission medium t=f${ESC}\\`,
    ]);
    expect(h.g.images.size).toBe(0);
  });
});

// A repaint with no placement left empties the overlay (width 0), so a frame after a
// removal shows whether the removal asked for one.
describe('a=d', () => {
  test('removes placements, repaints, and sends no reply', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.clock.frame();
    expect(h.overlay.width).toBe(800);
    h.sent.length = 0;
    h.g.feed(apc('a=d,d=i,i=1'));
    expect(h.g.placements.size).toBe(0);
    h.clock.frame();
    expect(h.overlay.width).toBe(0);
    expect(h.sent).toEqual([]);
  });

  test('d=a removes every placement and keeps the images; d=A drops the images too', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)) + apc('a=T,f=32,s=1,v=1,i=2,C=1', zeros(4)));
    await flush();
    h.g.feed(apc('a=d'));
    expect(h.g.placements.size).toBe(0);
    expect(h.g.images.ids()).toEqual([1, 2]);
    h.g.feed(apc('a=p,i=1,C=1') + apc('a=d,d=A'));
    expect(h.g.placements.size).toBe(0);
    expect(h.g.images.size).toBe(0);
  });

  test('d=i with p= removes only that placement; an unknown target removes nothing', async () => {
    const h = graphicsHarness();
    h.g.feed(
      apc('a=t,f=32,s=1,v=1,i=1', zeros(4)) + apc('a=p,i=1,p=1,C=1') + apc('a=p,i=1,p=2,C=1'),
    );
    await flush();
    h.g.feed(apc('a=d,d=i,i=1,p=1'));
    expect(h.g.placements.keys()).toEqual(['1:2']);
    h.g.feed(apc('a=d,d=z'));
    expect(h.g.placements.keys()).toEqual(['1:2']);
  });
});

describe('overlay invalidation', () => {
  test('replacing an image repaints the overlay even though it only removes placements', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.clock.frame();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    expect(h.g.placements.size).toBe(0);
    h.clock.frame();
    expect(h.overlay.width).toBe(0);
  });

  test('a failed decode removes what it placed, drops the image, and repaints', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=10,v=10,i=1,C=1', zeros(8))); // far too little pixel data
    expect(h.g.placements.size).toBe(1);
    h.clock.frame();
    expect(h.overlay.width).toBe(800);
    await flush();
    expect(h.g.placements.size).toBe(0);
    expect(h.g.images.size).toBe(0);
    h.clock.frame();
    expect(h.overlay.width).toBe(0);
    expect(h.sent).toEqual([`${ESC}_Gi=1;ENODATA:not enough pixel data${ESC}\\`]);
  });

  test('a clear in the output drops the placements and repaints', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.clock.frame();
    h.g.feed(`${ESC}[2J`);
    h.clock.frame();
    expect(h.overlay.width).toBe(0);
  });

  test('a decoded bitmap is drawn on the next frame, and invalidate() forces a redraw', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.clock.frame();
    expect(h.counts.drawn).toBe(0);
    await flush();
    h.clock.frame();
    expect(h.counts.drawn).toBe(1);
    h.clock.frame();
    expect(h.counts.repaints).toBe(2);
    h.g.invalidate();
    h.clock.frame();
    expect(h.counts.repaints).toBe(3);
  });

  test('a failed re-transmission keeps the previous bitmap for a=p to re-place', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.g.feed(apc('a=T,f=32,s=10,v=10,i=1,C=1', zeros(8)));
    await flush();
    expect(h.g.placements.size).toBe(0);
    expect(h.g.images.get(1)?.bitmap).toBeDefined();
  });
});

describe('reconnect', () => {
  test('a decode that finishes after reset() neither installs its bitmap nor replies', async () => {
    const h = graphicsHarness();
    const release = h.decoder.hold();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.g.reset();
    release();
    await flush();
    expect(h.g.images.size).toBe(0);
    expect(h.g.placements.size).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.decoder.bitmaps.every((b) => b.closed)).toBe(true);
  });

  test('a decode error after reset() does not reply into the new stream either', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=10,v=10,i=1,C=1', zeros(8)));
    h.g.reset();
    await flush();
    expect(h.sent).toEqual([]);
  });

  test('images from the old stream are freed and cannot be placed by the new one', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    await flush();
    h.sent.length = 0;
    const old = h.decoder.bitmaps[0];
    h.g.reset();
    expect(old.closed).toBe(true);
    h.g.feed(apc('a=p,i=1'));
    expect(h.sent).toEqual([`${ESC}_Gi=1;ENOENT:no such image${ESC}\\`]);
  });

  test('the new stream may reuse an image id', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.g.reset();
    h.g.feed(apc('a=T,f=32,s=2,v=2,i=1,C=1', zeros(16)));
    await flush();
    expect(h.g.images.get(1)?.bitmap).toMatchObject({ width: 2, height: 2, closed: false });
  });
});

describe('memory limits', () => {
  test('raw dimensions over the pixel limit are rejected before anything is decoded', () => {
    const h = graphicsHarness({ maxImagePixels: 100 });
    h.g.feed(apc('a=T,f=32,s=11,v=10,i=1,q=0', zeros(4)));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:image too large${ESC}\\`]);
    expect(h.g.images.size).toBe(0);
    expect(h.g.placements.size).toBe(0);
    expect(h.written).toEqual([]);
  });

  test('a PNG header over the limit is rejected up front', () => {
    const h = graphicsHarness({ maxImagePixels: 100 });
    h.g.feed(apc('a=t,f=100,i=1', b64(pngHeader(11, 10))));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:image too large${ESC}\\`]);
  });

  test('a compressed PNG that inflates to a too-large image is rejected after inflating', async () => {
    const h = graphicsHarness({ maxImagePixels: 100 });
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(11, 10)))));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:image too large${ESC}\\`]);
    expect(h.g.images.size).toBe(0);
  });

  test('a small zlib payload that expands past the expected size is cut off', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=t,f=32,s=2,v=2,o=z,i=1', b64(deflateSync(new Uint8Array(4 * 1024 * 1024)))));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:decompressed data too large${ESC}\\`]);
    expect(h.g.images.size).toBe(0);
  });

  test.each(['s=0,v=5', 's=-3,v=5', 's=2.5,v=5', 's=5'])(
    'invalid raw size %s is rejected',
    (dims) => {
      const h = graphicsHarness();
      h.g.feed(apc(`a=t,f=32,${dims},i=1`, zeros(64)));
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toContain('EINVAL');
      expect(h.g.images.size).toBe(0);
    },
  );

  test('the total decoded size is a budget: the oldest images go first, the newest stays', async () => {
    // each 2x2 image is 16 bytes decoded and, while decoding, holds 40 (16 of
    // RGBA plus its 24-character payload): room for two stored plus one decoding
    const h = graphicsHarness({ maxTotalBytes: 60 });
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=T,f=32,s=2,v=2,i=${id},C=1`, zeros(16)));
      await flush();
    }
    expect(h.g.images.ids()).toEqual([2, 3]);
    expect(h.decoder.bitmaps[0].closed).toBe(true);
    expect(h.decoder.bitmaps[2].closed).toBe(false);
    expect(h.g.placements.keys()).toEqual(['2:0', '3:0']);
  });

  test('the image count is capped and eviction removes the placements too', async () => {
    const h = graphicsHarness({ maxImages: 2 });
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=T,f=32,s=1,v=1,i=${id},C=1`, zeros(4)));
      await flush();
    }
    expect(h.g.images.ids()).toEqual([2, 3]);
    expect(h.g.placements.keys()).toEqual(['2:0', '3:0']);
  });

  test('a chunked transmission over the size cap gets one error and its later chunks are ignored', async () => {
    const h = graphicsHarness({ maxTransmissionBytes: 100 });
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1,m=1', 'A'.repeat(40)));
    h.g.feed(apc('m=1', 'A'.repeat(70))); // 110 > 100: dropped
    h.g.feed(apc('m=1', 'AAAA'));
    expect(h.sent).toEqual([]);
    h.g.feed(apc('m=0', 'AA'));
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:transmission too large${ESC}\\`]);
    expect(h.g.images.size).toBe(0);
    // and nothing that follows is affected
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=2', zeros(4)));
    await flush();
    expect(h.g.images.get(2)?.bitmap).toBeDefined();
  });
});

describe('compressed PNG', () => {
  test('a=T without C=1 is rejected: the cursor cannot be moved without the size', () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain('EINVAL');
    expect(h.sent[0]).toContain('C=1');
    expect(h.g.images.size).toBe(0);
    expect(h.g.placements.size).toBe(0);
    expect(h.written).toEqual([]);
  });

  test('a=T with C=1 is placed and decoded', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=100,o=z,i=1,C=1', b64(deflateSync(pngHeader(20, 40)))));
    expect(h.g.placements.size).toBe(1);
    await flush();
    expect(h.g.images.get(1)?.bitmap).toMatchObject({ width: 20, height: 40 });
  });

  test('a=t alone needs no size', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    await flush();
    expect(h.g.images.get(1)?.bitmap).toBeDefined();
    expect(h.sent).toEqual([`${ESC}_Gi=1;OK${ESC}\\`]);
  });

  test('a=p of it works once the decode has finished, using the decoded size', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(20, 40)))));
    await flush();
    h.written.length = 0;
    h.g.feed(apc('a=p,i=1'));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });
});

describe('source rectangle and display scale', () => {
  test('w/h are converted like the image before the cursor is moved', () => {
    const h = graphicsHarness();
    h.win.devicePixelRatio = 2;
    // cells are 10x20 CSS px = 20x40 device px. A 20x40 device-px region is one
    // cell; treating w/h as CSS px would advance two columns and two rows.
    h.g.feed(apc('a=T,f=32,s=100,v=100,w=20,h=40,i=1', zeros(100 * 100 * 4)));
    expect(h.written).toEqual([`${ESC}[4G`]);
  });

  test('without a source rectangle the whole image is used', () => {
    const h = graphicsHarness();
    h.win.devicePixelRatio = 2;
    h.g.feed(apc('a=T,f=32,s=40,v=80,i=1', zeros(40 * 80 * 4)));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });

  test('x/y shrink the default region', () => {
    const h = graphicsHarness();
    // 30x60 image, origin at 10,20: the visible 20x40 is 2 columns and 2 rows
    h.g.feed(apc('a=T,f=32,s=30,v=60,x=10,y=20,i=1', zeros(30 * 60 * 4)));
    expect(h.written).toEqual([`\n${ESC}[5G`]);
  });
});

describe('sequences split across chunks', () => {
  test('a clear split over two feeds drops the placements', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    expect(h.g.placements.size).toBe(1);
    h.g.feed(`text${ESC}[`);
    expect(h.g.placements.size).toBe(1);
    h.g.feed('2Jmore');
    expect(h.g.placements.size).toBe(0);
  });

  test('the text is still written to the terminal in the same pieces', () => {
    const h = graphicsHarness();
    h.g.feed(`a${ESC}[`);
    h.g.feed('2Jb');
    expect(h.written.join('')).toBe(`a${ESC}[2Jb`);
  });
});

describe('size queries', () => {
  test('are left to Ghostty, which answers them (ADR 042, ADR 047)', () => {
    const h = graphicsHarness();
    h.g.feed(`${ESC}[14t${ESC}[16t${ESC}[18t`);
    expect(h.sent).toEqual([]);
    expect(h.written.join('')).toBe(`${ESC}[14t${ESC}[16t${ESC}[18t`);
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
      const h = graphicsHarness({}, cell);
      h.win.devicePixelRatio = dpr;
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
    const h = graphicsHarness({ maxTransmissionBytes: 200 });
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', 'A'.repeat(300)));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:transmission too large${ESC}\\`]);
    expect(h.written).toEqual([]);
    expect(h.g.images.size).toBe(0);
  });

  test('the rest of a chunked transmission it started is ignored, with one error', () => {
    const h = graphicsHarness({ maxTransmissionBytes: 200 });
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1,m=1', 'A'.repeat(300))); // the first chunk is itself too big
    h.g.feed(apc('m=1', 'AAAA'));
    expect(h.sent).toEqual([]);
    h.g.feed(apc('m=0', 'AA'));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:transmission too large${ESC}\\`]);
  });

  test('one that is never terminated is ended by CAN, and text resumes', () => {
    const h = graphicsHarness({ maxTransmissionBytes: 100 });
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
    const h = graphicsHarness({ maxTotalBytes: 100 });
    const release = [h.decoder.hold(), h.decoder.hold()];
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=1', zeros(16)) + apc('a=t,f=32,s=2,v=2,i=2', zeros(16)));
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=3', zeros(16)));
    expect(h.sent).toEqual([`${ESC}_Gi=3;EINVAL:too many images being decoded${ESC}\\`]);
    expect(h.g.images.get(3)).toBeUndefined();
    for (const r of release) r();
    await flush();
    h.sent.length = 0;
    // the reservations were released, so there is room again
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=4', zeros(16)));
    await flush();
    expect(h.g.images.get(4)?.bitmap).toBeDefined();
  });

  test('a compressed PNG, whose size is unknown until decoded, reserves the worst case', async () => {
    // worst case: 100 pixels of RGBA (400 bytes) plus the payload
    const h = graphicsHarness({ maxImagePixels: 100, maxTotalBytes: 500 });
    const release = h.decoder.hold();
    h.g.feed(apc('a=t,f=100,o=z,i=1', b64(deflateSync(pngHeader(2, 2)))));
    h.g.feed(apc('a=t,f=100,o=z,i=2', b64(deflateSync(pngHeader(2, 2)))));
    expect(h.sent).toEqual([`${ESC}_Gi=2;EINVAL:too many images being decoded${ESC}\\`]);
    release();
    await flush();
  });

  test('a failed decode releases its reservation', async () => {
    const h = graphicsHarness({ maxTotalBytes: 500 });
    const tooLittle = () => h.g.feed(apc('a=t,f=32,s=10,v=10,i=1', zeros(8))); // reserves 412
    tooLittle();
    await flush();
    h.sent.length = 0;
    tooLittle(); // refused if the first still held its 412
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;ENODATA:not enough pixel data${ESC}\\`]);
  });

  test('stored images are dropped, oldest first, to make room for a new one', async () => {
    const h = graphicsHarness({ maxTotalBytes: 60 });
    for (const id of [1, 2, 3]) {
      h.g.feed(apc(`a=t,f=32,s=2,v=2,i=${id}`, zeros(16)));
      await flush();
    }
    expect(h.g.images.ids()).toEqual([2, 3]);
  });
});

describe('every transmission is answered', () => {
  test('one removed while it decodes gets an error instead of silence', async () => {
    const h = graphicsHarness({ maxImages: 1 });
    const releases = [h.decoder.hold(), h.decoder.hold()];
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=2', zeros(4))); // evicts image 1 while it is still decoding
    for (const r of releases) r();
    await flush();
    expect(h.sent).toContain(
      `${ESC}_Gi=1;EINVAL:image was removed before it finished decoding${ESC}\\`,
    );
    expect(h.sent).toContain(`${ESC}_Gi=2;OK${ESC}\\`);
    expect(h.g.images.get(1)).toBeUndefined();
    expect(h.decoder.bitmaps[0].closed).toBe(true);
  });

  test('one deleted while it decodes gets the same error', async () => {
    const h = graphicsHarness();
    const release = h.decoder.hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.feed(apc('a=d,d=I,i=1'));
    release();
    await flush();
    expect(h.sent).toEqual([
      `${ESC}_Gi=1;EINVAL:image was removed before it finished decoding${ESC}\\`,
    ]);
  });

  test('one superseded by a newer transmission that already finished still gets its OK', async () => {
    const h = graphicsHarness();
    const releaseOld = h.decoder.hold();
    const releaseNew = h.decoder.hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.feed(apc('a=t,f=32,s=2,v=2,i=1', zeros(16))); // replaces it
    releaseNew();
    await flush();
    expect(h.g.images.get(1)?.bitmap).toMatchObject({ width: 2 });
    releaseOld();
    await flush();
    expect(h.sent).toEqual([`${ESC}_Gi=1;OK${ESC}\\`, `${ESC}_Gi=1;OK${ESC}\\`]);
    expect(h.decoder.bitmaps.find((b) => b.width === 1)?.closed).toBe(true);
    expect(h.g.images.get(1)?.bitmap).toMatchObject({ width: 2, closed: false });
  });

  test('an older transmission that finishes first is shown until the newer one is ready', async () => {
    const h = graphicsHarness();
    const releaseOld = h.decoder.hold();
    const releaseNew = h.decoder.hold();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    h.g.feed(apc('a=T,f=32,s=2,v=2,i=1,C=1', zeros(16)));
    releaseOld();
    await flush();
    // a stream of frames must not be blank while decoding lags behind it
    expect(h.g.images.get(1)?.bitmap).toMatchObject({ width: 1 });
    releaseNew();
    await flush();
    expect(h.g.images.get(1)?.bitmap).toMatchObject({ width: 2 });
    expect(h.decoder.bitmaps[0].closed).toBe(true);
  });

  test('a stream reset answers nothing for decodes that were running', async () => {
    const h = graphicsHarness();
    const release = h.decoder.hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=1', zeros(4)));
    h.g.reset();
    release();
    await flush();
    expect(h.sent).toEqual([]);
  });
});

describe('placements are sized from the current transmission', () => {
  test('a=p of a compressed PNG replacing a decoded image does not borrow the old bitmap size', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=20,v=40,i=1,C=1', zeros(20 * 40 * 4)));
    await flush();
    const release = h.decoder.hold();
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
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=10,v=20,i=1,C=1', zeros(10 * 20 * 4))); // one cell
    await flush();
    const release = h.decoder.hold();
    h.g.feed(apc('a=t,f=32,s=40,v=40,i=1', zeros(40 * 40 * 4))); // 4 columns, 2 rows
    h.written.length = 0;
    h.g.feed(apc('a=p,i=1'));
    expect(h.written).toEqual([`\n${ESC}[7G`]); // column 2 + 4 + 1
    release();
    await flush();
  });
});

describe('overlay backing store', () => {
  test('a new overlay is empty and reads no layout while there is no image', () => {
    const h = graphicsHarness();
    expect(h.overlay).toMatchObject({ width: 0, height: 0 });
    h.clock.frame();
    h.clock.frame();
    expect(h.counts.reads).toBe(0);
    expect(h.overlay).toMatchObject({ width: 0, height: 0 });
  });

  test('the overlay grows for an image and shrinks back to empty when the last one goes', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    h.clock.frame();
    expect(h.overlay).toMatchObject({ width: 800, height: 600 });
    h.g.feed(apc('a=d,d=I,i=1'));
    h.clock.frame();
    expect(h.overlay).toMatchObject({ width: 0, height: 0 });
    h.counts.reads = 0;
    h.clock.frame();
    expect(h.counts.reads).toBe(0);
  });
});

describe('dispose', () => {
  test('frees the images, removes the overlay, stops the frames and silences running decodes', async () => {
    const h = graphicsHarness();
    h.g.feed(apc('a=T,f=32,s=1,v=1,i=1,C=1', zeros(4)));
    await flush();
    const release = h.decoder.hold();
    h.g.feed(apc('a=t,f=32,s=1,v=1,i=2', zeros(4)));
    h.sent.length = 0;
    h.g.dispose();
    expect(h.g.images.size).toBe(0);
    expect(h.g.placements.size).toBe(0);
    expect(h.decoder.bitmaps[0].closed).toBe(true);
    expect(h.overlay.isConnected).toBe(false);
    expect(h.clock.pending.frames).toBe(0);
    release();
    await flush();
    expect(h.sent).toEqual([]);
    h.g.dispose();
    expect(h.clock.pending.frames).toBe(0);
  });
});

describe('a header that only looks like a PNG', () => {
  test.each([
    ['signature', (b: Uint8Array) => (b[0] = 0x00)],
    ['IHDR length', (b: Uint8Array) => (b[11] = 12)],
    ['IHDR type', (b: Uint8Array) => (b[15] = 0x58)],
  ])('with a bad %s is refused before the cursor moves', (_name, corrupt) => {
    const h = graphicsHarness();
    const bad = pngHeader(20, 40);
    corrupt(bad);
    h.g.feed(apc('a=T,f=100,i=1', b64(bad)));
    expect(h.sent).toEqual([`${ESC}_Gi=1;EINVAL:not a PNG${ESC}\\`]);
    expect(h.written).toEqual([]);
    expect(h.g.placements.size).toBe(0);
    expect(h.g.images.size).toBe(0);
  });
});
