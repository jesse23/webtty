import { describe, expect, test } from 'bun:test';
import {
  AT_ONCE,
  easeOutCubic,
  FRAME_MS,
  Glide,
  SPRING_RELEASE_MS,
  springOmega,
  springStep,
} from '../../ghostty-web/glide';

describe('springStep', () => {
  test('approaches a target from rest without overshooting', () => {
    let [x, v] = [0, 0];
    for (let i = 0; i < 60; i++) {
      [x, v] = springStep(x, v, 10, 28, FRAME_MS / 1000);
      expect(x).toBeLessThanOrEqual(10);
    }
    expect(x).toBeCloseTo(10, 3);
  });

  test('is the same in one step as in many', () => {
    const one = springStep(0, 5, 10, 28, 0.1);
    let [x, v] = [0, 5];
    for (let i = 0; i < 10; i++) [x, v] = springStep(x, v, 10, 28, 0.01);
    expect(x).toBeCloseTo(one[0], 9);
    expect(v).toBeCloseTo(one[1], 9);
  });
});

describe('springOmega', () => {
  test('doubles once the target has not moved for the release time', () => {
    expect(springOmega(28, SPRING_RELEASE_MS)).toBe(28);
    expect(springOmega(28, SPRING_RELEASE_MS + 1)).toBe(56);
  });
});

describe('Glide', () => {
  test('at once puts the value on the target', () => {
    const g = new Glide();
    g.retarget(4, AT_ONCE, 0);
    expect([g.value, g.target, g.active]).toEqual([4, 4, false]);
  });

  test('a timed glide starts a frame early, so its first frame moves', () => {
    const g = new Glide();
    g.retarget(4, { duration: 100 }, 1000);
    g.step(1000, 1e-3);
    expect(g.value).toBeCloseTo(4 * (FRAME_MS / 100));
  });

  test('a timed glide ends on its target', () => {
    const g = new Glide();
    g.retarget(4, { duration: 100, ease: easeOutCubic }, 0);
    for (let now = FRAME_MS; now < 200; now += FRAME_MS) g.step(now, 1e-3);
    expect([g.value, g.active]).toEqual([4, false]);
  });

  test('a shift moves a running glide by as much, and it goes on the same way (ADR 066)', () => {
    const plain = new Glide();
    const shifted = new Glide();
    for (const g of [plain, shifted]) {
      g.retarget(4, { duration: 100 }, 0);
      g.step(50, 1e-3);
    }
    shifted.shift(10);
    expect([shifted.value, shifted.target]).toEqual([plain.value + 10, 14]);
    for (const g of [plain, shifted]) g.step(75, 1e-3);
    expect(shifted.value).toBeCloseTo(plain.value + 10);
    for (const g of [plain, shifted]) g.step(200, 1e-3);
    expect([shifted.value, shifted.active]).toEqual([14, false]);
  });

  test.each([
    ['an eased glide', { duration: 125, ease: easeOutCubic }],
    ['a spring', { duration: 125, omega: 28 }],
  ])('%s shifted with its target kept moves at once and still ends there (ADR 066)', (_, pace) => {
    const g = new Glide();
    g.jump(10);
    g.retarget(0, pace, 0);
    g.step(FRAME_MS, 1e-3);
    g.step(2 * FRAME_MS, 1e-3);
    const before = g.value;
    g.shift(3, 0);
    expect([g.value, g.target]).toEqual([before + 3, 0]);
    // It keeps heading down from there, and arrives
    g.step(3 * FRAME_MS, 1e-3);
    expect(g.value).toBeLessThan(before + 3);
    for (let t = 4; t < 60; t++) g.step(t * FRAME_MS, 1e-3);
    expect([g.value, g.active]).toEqual([0, false]);
  });

  test('a timed glide shifted with its target kept lands on time', () => {
    const plain = new Glide();
    const shifted = new Glide();
    for (const g of [plain, shifted]) {
      g.jump(10);
      g.retarget(0, { duration: 100 }, 0);
      g.step(50, 1e-3);
    }
    shifted.shift(4, 0);
    // Part of the way there, part of the shift is left
    for (const g of [plain, shifted]) g.step(70, 1e-3);
    expect(shifted.value).toBeGreaterThan(plain.value);
    expect(shifted.value).toBeLessThan(plain.value + 4);
    for (const g of [plain, shifted]) g.step(100, 1e-3);
    expect([shifted.value, shifted.active]).toEqual([plain.value, plain.active]);
  });

  test('a timed glide shifted to a clamped target eases in to it on time', () => {
    const g = new Glide();
    g.retarget(10, { duration: 100, ease: easeOutCubic }, 0);
    g.step(50, 1e-3);
    // The target moved past where the value may go (the oldest line): it ends there, at
    // 10.1, not at 10.3
    g.shift(0.3, 10.1);
    const values: number[] = [];
    for (let now = 60; now <= 100; now += 10) {
      g.step(now, 1e-3);
      values.push(g.value);
    }
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.at(-1)).toBe(10.1);
    expect(g.active).toBe(false);
  });

  test('a retarget during a glide continues from its latest frame', () => {
    const g = new Glide();
    g.retarget(4, { duration: 100 }, 0);
    g.step(FRAME_MS, 1e-3);
    const at = g.value;
    g.retarget(8, { duration: 100 }, FRAME_MS + 5);
    // Measured from the latest frame, the next frame moves a full frame's share.
    g.step(2 * FRAME_MS, 1e-3);
    expect(g.value).toBeCloseTo(at + (8 - at) * (FRAME_MS / 100));
  });

  test('a spring takes over at the current speed', () => {
    const g = new Glide();
    g.retarget(100, { duration: 100 }, 0);
    g.step(FRAME_MS, 1e-3);
    const before = g.value;
    g.step(2 * FRAME_MS, 1e-3);
    const linearStep = g.value - before;
    g.retarget(200, { duration: 100, omega: 28 }, 2 * FRAME_MS);
    const from = g.value;
    g.step(3 * FRAME_MS, 1e-3);
    // Not starting from rest: the first spring frame keeps most of the speed.
    expect(g.value - from).toBeGreaterThan(linearStep * 0.8);
  });

  test('a spring taking over a steady stream does not slow the value down much', () => {
    const g = new Glide();
    // 300 units every 30 ms, gliding linearly over each gap plus a frame for the first
    // four, then following a spring; frames at 60 Hz, independent of the events.
    const moved: number[] = [];
    let target = 0;
    let event = 0;
    for (let frame = 1; frame <= 24; frame++) {
      const now = frame * FRAME_MS;
      for (; event * 30 <= now && event < 12; event++) {
        target += 300;
        const pace = event < 4 ? { duration: 30 + FRAME_MS } : { duration: 125, omega: 28 };
        g.retarget(target, pace, event * 30);
      }
      const before = g.value;
      g.step(now, 1e-3);
      if (event > 4) moved.push(g.value - before);
    }
    // The input moves 167 per frame. Opening the spring's lag at once dipped to 89.
    expect(Math.min(...moved.slice(0, 12))).toBeGreaterThan(0.55 * 167);
  });

  test('a spring settles on its target', () => {
    const g = new Glide();
    g.retarget(10, { duration: 100, omega: 28 }, 0);
    for (let now = FRAME_MS; now < 1000 && g.active; now += FRAME_MS) g.step(now, 0.01);
    expect([g.value, g.active]).toEqual([10, false]);
  });

  test('jump stops where it puts the value', () => {
    const g = new Glide();
    g.retarget(10, { duration: 100 }, 0);
    g.jump(3);
    expect([g.value, g.target, g.active]).toEqual([3, 3, false]);
  });
});
