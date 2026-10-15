import { describe, expect, test } from 'bun:test';
import {
  atBottom,
  averageStepPx,
  BAR_BRIGHTNESS,
  bestShift,
  blinkFrames,
  matchPairs,
  median,
  nothingMoved,
  type PaintFrame,
  type Profile,
  paintStats,
  type StreamFrame,
  scrollWindow,
  streamStats,
} from './metrics';

const HEIGHT = 640;
const SCROLL_WINDOW = scrollWindow(60);

/** A textured page, so every shift of it looks different: brightness of content row y. */
const page = (y: number): number => 60 + 40 * Math.sin(y * 0.37) + 12 * ((y * 31) % 7);

/** The page scrolled down by `offset` px. */
const frame = (offset: number): number[] =>
  Array.from({ length: HEIGHT }, (_, y) => page(y + offset));

/** Frames of a smooth scroll, `step` px apart. */
const smooth = (count: number, step: number): number[][] =>
  Array.from({ length: count }, (_, k) => frame(k * step));

const blinksIn = (profiles: Profile[]): number[] =>
  blinkFrames(profiles, matchPairs(profiles, SCROLL_WINDOW), SCROLL_WINDOW);

describe('bestShift', () => {
  test('finds the shift between two frames of the same page, with no error', () => {
    const match = bestShift(frame(0), frame(5), SCROLL_WINDOW);
    expect(match.shift).toBe(-5);
    expect(match.error).toBeCloseTo(0, 6);
  });

  test('a different picture has a large error at every shift', () => {
    const flat = Array.from({ length: HEIGHT }, () => 0);
    expect(bestShift(frame(0), flat, SCROLL_WINDOW).error).toBeGreaterThan(3);
  });

  test("finds a hard TrackPoint push's 160 px step in a window wide enough", () => {
    const match = bestShift(frame(0), frame(160), scrollWindow(200));
    expect(match.shift).toBe(-160);
    expect(match.error).toBeCloseTo(0, 6);
  });

  test('throws on a margin narrower than the shift, or no rows left to compare', () => {
    expect(() => bestShift(frame(0), frame(1), { maxShift: 60, margin: 50 })).toThrow('margin');
    expect(() => bestShift(frame(0), frame(1), scrollWindow(HEIGHT / 2))).toThrow('too short');
  });
});

describe('blinkFrames', () => {
  const torn = (offset: number): number[] =>
    frame(offset).map((v, y) => (y < HEIGHT / 2 ? page(y + offset + 25) : v));
  const level = (v: number): number[] => Array.from({ length: HEIGHT }, () => v);
  const flashed = (): number[] => level(0);

  const cases: [string, () => number[][], number[]][] = [
    ['a smooth scroll', () => smooth(12, 3), []],
    ['a fast smooth scroll', () => smooth(12, 40), []],
    // Errors 20 and 15 to the middle frame, 5 across: relatively close, still different.
    ['three frames that all differ (an app redrawing)', () => [0, 20, 5].map(level), []],
    ['a still view', () => smooth(12, 0), []],
    ['a single transient frame', () => smooth(12, 3).map((p, k) => (k === 5 ? flashed() : p)), [5]],
    ['a torn half-frame', () => smooth(12, 3).map((p, k) => (k === 6 ? torn(18) : p)), [6]],
    [
      'a cut to another picture that stays',
      () => smooth(12, 3).map((p, k) => (k >= 5 ? flashed() : p)),
      [],
    ],
  ];
  for (const [name, make, expected] of cases) {
    test(name, () => expect(blinksIn(make())).toEqual(expected));
  }
});

describe('averageStepPx', () => {
  const stepOf = (profiles: Profile[]) =>
    averageStepPx(matchPairs(profiles, SCROLL_WINDOW), SCROLL_WINDOW);

  test('the mean distance of the frames that moved', () => {
    expect(stepOf(smooth(6, 4))).toBe(4);
  });
  test('0 when nothing moved', () => {
    expect(stepOf(smooth(4, 0))).toBe(0);
    expect(averageStepPx([], SCROLL_WINDOW)).toBe(0);
  });
  test('leaves out pairs that are a different picture or at the edge of the window', () => {
    const pairs = [
      { shift: 4, error: 0.5 },
      { shift: -17, error: 9 },
      { shift: 60, error: 1 },
      { shift: -60, error: 1 },
      { shift: -6, error: 2 },
    ];
    expect(averageStepPx(pairs, SCROLL_WINDOW)).toBe(5);
  });
});

describe('paintStats', () => {
  const frames: PaintFrame[] = [
    [0, true],
    [16, true],
    [32, false],
    [48, true],
    [64, true],
    [1000, true],
  ];

  test('counts paints from the first wheel to the tail after the last', () => {
    expect(paintStats(frames, [0, 100])).toEqual({
      paintsPerSec: 13.3,
      gapMedian: 16,
      gapP90: 32,
    });
  });

  test('a shorter tail leaves out later paints', () => {
    expect(paintStats(frames, [0, 40], 10).paintsPerSec).toBe(60);
  });

  test('no wheel events, no stats', () => {
    expect(paintStats(frames, [])).toEqual({ paintsPerSec: 0, gapMedian: 0, gapP90: 0 });
  });
});

describe('streamStats', () => {
  const withBar = (offset: number): number[] =>
    frame(offset).map((v, y) => (y === HEIGHT - 10 ? BAR_BRIGHTNESS + 50 : Math.min(v, 140)));
  const scrolled = (offset: number): number[] => frame(offset).map((v) => Math.min(v, 140));

  test('atBottom sees the inverse status bar', () => {
    expect(atBottom(withBar(0))).toBe(true);
    expect(atBottom(scrolled(0))).toBe(false);
  });

  test('splits frames at the scroll end plus settle, counting bottoms and moves', () => {
    const frames: StreamFrame[] = [
      { time: 0, profile: withBar(0) },
      { time: 100, profile: scrolled(30) },
      { time: 200, profile: withBar(0) },
      { time: 700, profile: scrolled(30) },
      { time: 800, profile: scrolled(30) },
      { time: 900, profile: scrolled(36) },
      { time: 1000, profile: withBar(0) },
    ];
    expect(streamStats(frames, 300, 300)).toEqual({
      framesDuringScroll: 3,
      atBottomDuringScroll: 2,
      framesAtRest: 4,
      atBottomAtRest: 1,
      restFramesThatMoved: 3,
    });
  });
});

describe('median', () => {
  const cases: [number[], number][] = [
    [[], 0],
    [[5], 5],
    [[3, 1, 2], 2],
    [[4, 1, 3, 2], 2.5],
  ];
  for (const [values, expected] of cases) {
    test(`${JSON.stringify(values)} → ${expected}`, () => expect(median(values)).toBe(expected));
  }
});

describe('nothingMoved', () => {
  test.each([
    [{ frames: 7, paintsPerSec: 1.9 }, true],
    [{ frames: 10, paintsPerSec: 2.9 }, true],
    [{ frames: 33, paintsPerSec: 10.2 }, false],
    [{ frames: 8, paintsPerSec: 6 }, false],
  ])('%j: %p', (run, idle) => expect(nothingMoved(run)).toBe(idle));
});
