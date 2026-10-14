import { describe, expect, test } from 'bun:test';
import { ImageStore, imageIdOf } from './image-store';
import { fakeBitmap } from './test-support/graphics-harness';

/** A store with generous limits unless overridden, recording what it drops. */
function store(limits: { maxImages?: number; maxTotalBytes?: number } = {}) {
  const dropped: number[] = [];
  const images = new ImageStore({ maxImages: 256, maxTotalBytes: 1 << 20, ...limits }, (id) =>
    dropped.push(id),
  );
  return { images, dropped };
}

/** Opens `id` and installs a decoded `w` x `h` bitmap into it. */
function add(images: ImageStore, id: number, w = 2, h = 2) {
  const { slot, seq } = images.open(id, { width: w, height: h });
  const bitmap = fakeBitmap(w, h);
  images.install(id, slot, seq, bitmap);
  return bitmap;
}

describe('imageIdOf', () => {
  test.each([
    [{ i: '7' }, 7],
    [{ I: '3' }, 0x40000003],
    [{ i: '7', I: '3' }, 7],
    [{}, 0],
  ])('%o names image %d', (keys, id) => {
    expect(imageIdOf(keys)).toBe(id);
  });
});

describe('ImageStore', () => {
  test('anonymous ids count down from -1', () => {
    const { images } = store();
    expect([images.nextAnonymousId(), images.nextAnonymousId()]).toEqual([-1, -2]);
  });

  test('open creates a slot with the transmission size and numbers its transmissions', () => {
    const { images } = store();
    expect(images.open(5, { width: 3, height: 4 }).seq).toBe(1);
    const again = images.open(5, { width: 6, height: 8 });
    expect(again.seq).toBe(2);
    expect(images.get(5)).toMatchObject({ width: 6, height: 8, latest: 2, applied: 0 });
    expect(images.bitmapOf(5)).toBeUndefined();
  });

  describe('eviction order', () => {
    test('past maxImages the oldest goes first, and its owner is told', () => {
      const { images, dropped } = store({ maxImages: 2 });
      const first = add(images, 1);
      add(images, 2);
      add(images, 3);
      expect(images.ids()).toEqual([2, 3]);
      expect(dropped).toEqual([1]);
      expect(first.closed).toBe(true);
    });

    test('re-transmitting an id makes it the newest, so it outlives older ones', () => {
      const { images, dropped } = store({ maxImages: 2 });
      add(images, 1);
      add(images, 2);
      images.open(1, { width: 2, height: 2 });
      add(images, 3);
      expect(images.ids()).toEqual([1, 3]);
      expect(dropped).toEqual([2]);
    });

    test('the byte budget drops oldest first and keeps the newest', () => {
      const { images, dropped } = store({ maxTotalBytes: 20 });
      for (const id of [1, 2, 3]) add(images, id);
      expect(images.ids()).toEqual([3]);
      expect(dropped).toEqual([1, 2]);
    });

    test('enforceBudget(false, extra) may drop every image and says whether it then fits', () => {
      const { images } = store({ maxTotalBytes: 40 });
      add(images, 1);
      add(images, 2);
      expect(images.enforceBudget(false, 16)).toBe(true);
      expect(images.ids()).toEqual([2]);
      expect(images.enforceBudget(false, 100)).toBe(false);
      expect(images.size).toBe(0);
    });

    test('in-flight bytes count against the budget until released', () => {
      const { images } = store({ maxTotalBytes: 100 });
      images.holdInFlight(90);
      expect(images.enforceBudget(false, 20)).toBe(false);
      images.releaseInFlight(90);
      expect(images.enforceBudget(false, 20)).toBe(true);
    });
  });

  describe('install', () => {
    test('a newer bitmap replaces the older one and takes its size and bytes', () => {
      const { images } = store({ maxTotalBytes: 64 });
      const old = add(images, 1, 2, 2);
      const fresh = add(images, 1, 4, 4);
      expect(old.closed).toBe(true);
      expect(images.bitmapOf(1)).toBe(fresh);
      expect(images.get(1)).toMatchObject({ width: 4, height: 4, bytes: 64 });
      // 64 bytes held, and the newest is kept: one more 2x2 does not fit beside it
      expect(images.enforceBudget(true, 16)).toBe(false);
    });

    test('an older transmission finishing late is superseded and closed', () => {
      const { images } = store();
      const first = images.open(1, { width: 1, height: 1 });
      const second = images.open(1, { width: 2, height: 2 });
      expect(images.install(1, second.slot, second.seq, fakeBitmap(2, 2))).toBe('installed');
      const late = fakeBitmap(1, 1);
      expect(images.install(1, first.slot, first.seq, late)).toBe('superseded');
      expect(late.closed).toBe(true);
      expect(images.bitmapOf(1)?.width).toBe(2);
    });

    test('an older transmission finishing first is shown but keeps the newer size', () => {
      const { images } = store();
      const first = images.open(1, { width: 1, height: 1 });
      images.open(1, { width: 2, height: 2 });
      expect(images.install(1, first.slot, first.seq, fakeBitmap(1, 1))).toBe('installed');
      expect(images.get(1)).toMatchObject({ width: 2, height: 2, applied: 1 });
    });

    test('a bitmap for a slot dropped meanwhile is closed and reported removed', () => {
      const { images } = store();
      const { slot, seq } = images.open(1, { width: 1, height: 1 });
      images.drop(1);
      const bitmap = fakeBitmap(1, 1);
      expect(images.install(1, slot, seq, bitmap)).toBe('removed');
      expect(bitmap.closed).toBe(true);
      expect(images.isNewest(1, slot, seq)).toBe(false);
    });

    test('isNewest is true only for the latest transmission into a held slot', () => {
      const { images } = store();
      const first = images.open(1, { width: 1, height: 1 });
      expect(images.isNewest(1, first.slot, first.seq)).toBe(true);
      images.open(1, { width: 1, height: 1 });
      expect(images.isNewest(1, first.slot, first.seq)).toBe(false);
    });
  });

  describe('drop', () => {
    test('an unknown id is ignored', () => {
      const { images, dropped } = store();
      images.drop(9);
      expect(dropped).toEqual([]);
    });

    test('dropAll frees every bitmap, oldest first, and returns the bytes', () => {
      const { images, dropped } = store({ maxTotalBytes: 32 });
      const bitmaps = [add(images, 1), add(images, 2)];
      images.dropAll();
      expect(dropped).toEqual([1, 2]);
      expect(bitmaps.every((b) => b.closed)).toBe(true);
      expect(images.enforceBudget(false, 32)).toBe(true);
    });
  });
});
