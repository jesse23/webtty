import { describe, expect, test } from 'bun:test';
import { STREAM_OMEGA, WHEEL_GLIDE_MS, WheelClassifier, WheelStream } from './wheel-stream';

describe('WheelStream.forApp', () => {
  const scroll = () => new WheelStream();
  const at = (deltaY: number, timeStamp: number, deltaMode = 0) =>
    ({ deltaX: 0, deltaY, deltaMode, timeStamp }) as WheelEvent;

  test('spreads a sparse delta over its gap plus a frame', () => {
    const s = scroll();
    s.forApp(at(-4.000244140625, 1000));
    expect(s.forApp(at(-95.0897216796875, 1040)).duration).toBeCloseTo(40 + 1000 / 60);
  });

  test('caps the spread at the wheel glide time', () => {
    const s = scroll();
    s.forApp(at(-4.000244140625, 1000));
    expect(s.forApp(at(-30.25, 1200)).duration).toBe(WHEEL_GLIDE_MS);
  });

  test('spreads a wheel notch over the wheel glide time', () => {
    expect(scroll().forApp(at(-3, 1000, 1)).duration).toBe(WHEEL_GLIDE_MS);
  });

  test('a sparse stream stays paced through one short gap', () => {
    const s = scroll();
    s.forApp(at(-23.5, 1000));
    expect(s.forApp(at(-63.25, 1040)).duration).toBeCloseTo(40 + 1000 / 60);
    // The capture's 25 ms gap replays as 24.9 ms.
    expect(s.forApp(at(-95.5, 1064.9)).duration).toBeCloseTo(24.9 + 1000 / 60);
    expect(s.forApp(at(-120.75, 1100)).duration).toBeCloseTo(35.1 + 1000 / 60);
  });

  test('a wheel notch soon after one in the same direction continues linearly', () => {
    const s = scroll();
    expect(s.forApp(at(-3, 1000, 1)).duration).toBe(WHEEL_GLIDE_MS);
    expect(s.forApp(at(-3, 1150, 1)).duration).toBeCloseTo(150 + 1000 / 60);
    // Reversing, or after a pause, a notch eases out again.
    expect(s.forApp(at(3, 1200, 1)).duration).toBe(WHEEL_GLIDE_MS);
    expect(s.forApp(at(3, 1500, 1)).duration).toBe(WHEEL_GLIDE_MS);
  });

  test('a fast sparse stream follows a spring', () => {
    const s = scroll();
    let t = 1000;
    s.forApp(at(-23.5, t));
    const paces = [40, 35, 30, 45, 33, 38, 31].map((gap, i) => {
      t += gap;
      return s.forApp(at(-(100.5 + i * 1.25), t));
    });
    // The pause before the stream counts as a slow gap, so it starts linear and
    // turns into a spring once the average gap drops under 60 ms.
    expect(paces[0].omega).toBeUndefined();
    expect(paces.at(-1)?.omega).toBe(STREAM_OMEGA);
  });

  test('sends trackpad deltas at once', () => {
    const s = scroll();
    s.forApp(at(-20.5, 1200));
    s.forApp(at(-21.25, 1208));
    // Two short gaps in a row end the sparse stream a gesture starts as.
    expect(s.forApp(at(-22.75, 1216)).duration).toBe(0);
  });
});

describe('WheelClassifier', () => {
  const feed = (deltas: [number, number][]) => {
    const c = new WheelClassifier();
    for (const [x, y] of deltas) c.accept(x, y);
    return c.isPhysicalMouseWheel();
  };

  test('steady integer notches are a wheel', () => {
    expect(
      feed([
        [0, 4],
        [0, 4],
        [0, 8],
        [0, 4],
      ]),
    ).toBe(true);
  });

  test('fractional, accelerating deltas are a trackpad', () => {
    expect(
      feed([
        [0, 1.5],
        [0, 3.25],
        [0, 7.75],
        [0, 12.5],
      ]),
    ).toBe(false);
  });

  test('both axes at once are a trackpad', () => {
    expect(
      feed([
        [0, 4],
        [0, 4],
        [1, 4],
        [2, 6],
      ]),
    ).toBe(false);
  });

  test('no events is not a wheel', () => {
    expect(new WheelClassifier().isPhysicalMouseWheel()).toBe(false);
  });
});

describe('WheelStream with reduced motion', () => {
  function reduced(run: () => void) {
    const g = globalThis as { matchMedia?: unknown };
    const saved = g.matchMedia;
    g.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
    try {
      run();
    } finally {
      g.matchMedia = saved;
    }
  }
  const at = (deltaY: number, timeStamp: number, deltaMode = 0) =>
    ({ deltaX: 0, deltaY, deltaMode, timeStamp }) as WheelEvent;

  test('everything moves the scrollback at once', () => {
    reduced(() => {
      const s = new WheelStream();
      expect(s.forScrollback(at(-3, 1000, 1)).duration).toBe(0);
      s.forScrollback(at(-95.5, 2000));
      expect(s.forScrollback(at(-97.25, 2040)).duration).toBe(0);
    });
  });

  test("a wheel notch's ticks go at once, a sparse stream's stay paced", () => {
    reduced(() => {
      const s = new WheelStream();
      expect(s.forApp(at(-3, 1000, 1)).duration).toBe(0);
      s.forApp(at(-95.5, 2000));
      expect(s.forApp(at(-97.25, 2040)).duration).toBeGreaterThan(0);
    });
  });
});

describe('WheelStream classifies each event once', () => {
  test('asking about the same event again does not count it twice', () => {
    const s = new WheelStream();
    const first = { deltaX: 0, deltaY: -95.5, deltaMode: 0, timeStamp: 1000 } as WheelEvent;
    const second = { deltaX: 0, deltaY: -97.25, deltaMode: 0, timeStamp: 1040 } as WheelEvent;
    s.forApp(first);
    const pace = s.forApp(second);
    expect(s.forScrollback(second)).toEqual(pace);
    expect(s.forApp(second)).toEqual(pace);
  });
});
