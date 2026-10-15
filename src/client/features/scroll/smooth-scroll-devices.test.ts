import { describe, expect, test } from 'bun:test';
import { easeOutCubic, linear, type Pace, type Terminal } from '../../vendor/ghostty-web';
import { SmoothScroll } from './smooth-scroll';
import { WheelStream } from './wheel-stream';

// Output while the scrollback glides, for every input device (ADR 045, ADR 066): event
// sequences WheelStream really classifies as a trackpad, a mouse wheel notch, a spinning
// wheel and a TrackPoint, slow and fast. Output arriving mid-glide must leave the text in
// view where it is, and the glide must go on covering the distance it had left, frame by
// frame as if no output had come; one heading for the bottom still ends there. The output
// comes during the events (a trackpad's run, while its view moves) or after the last one
// (mid-glide). The terminal here stands in for the pin; smooth-scroll-kept-view.test.ts
// drives the real one.

/** A wheel event `gap` ms after the one before it. */
interface Step {
  deltaY: number;
  deltaMode?: number;
  gap: number;
}

/** Each device: its events (scrolling up), and how WheelStream paces the last one. */
const DEVICES: [string, Step[], 'at once' | 'ease out' | 'linear' | 'spring'][] = [
  [
    'trackpad',
    Array.from({ length: 8 }, (_, i) => ({ deltaY: -(6.25 + i * 0.75), gap: 16 })),
    'at once',
  ],
  ['mouse wheel notch', [{ deltaY: -3, deltaMode: 1, gap: 0 }], 'ease out'],
  [
    'spinning mouse wheel',
    [0, 60, 60, 60].map((gap) => ({ deltaY: -3, deltaMode: 1, gap })),
    'linear',
  ],
  [
    'TrackPoint, slow',
    [0, 100, 110, 95].map((gap, i) => ({ deltaY: -(23.5 + i * 1.25), gap })),
    'linear',
  ],
  [
    'TrackPoint, fast',
    [0, 40, 35, 30, 45, 33, 38, 31].map((gap, i) => ({ deltaY: -(23.5 + i * 1.25), gap })),
    'spring',
  ],
];

/** The kind of motion a pace makes. */
function kind(pace: Pace): string {
  if (pace.omega) return 'spring';
  if (pace.duration <= 0) return 'at once';
  return pace.ease === easeOutCubic ? 'ease out' : pace.ease === linear ? 'linear' : 'other';
}

const CELL = 10;

/**
 * A terminal whose view a write moves as ghostty-web's Viewport.pin / unpin does: a view
 * scrolled back, or showing part of the row above, moves up by the lines written.
 */
function terminal() {
  const offsets: number[] = [];
  let scrolled = (_y: number) => {};
  const term = {
    viewportY: 0,
    scrollback: 1000,
    rows: 40,
    wasmTerm: { isAlternateScreen: () => false },
    renderer: {
      getMetrics: () => ({ height: CELL }),
      setScrollOffset: (offset: number) => offsets.push(offset),
    },
    onScroll: (cb: (y: number) => void) => {
      scrolled = cb;
      return { dispose: () => {} };
    },
    onResize: () => ({ dispose: () => {} }),
    getScrollbackLength: () => term.scrollback,
    scrollToLine(line: number) {
      term.viewportY = line;
    },
  };
  const write = (lines: number) => {
    term.scrollback += lines;
    if (term.viewportY > 0 || (offsets.at(-1) ?? 0) > 0) term.viewportY += lines;
  };
  /** Where the view's top is in the text, in lines from the oldest one. */
  const top = () => term.scrollback - term.viewportY - (offsets.at(-1) ?? 0) / CELL;
  return { term, write, top, scrolled: (y: number) => scrolled(y) };
}

/**
 * Plays `steps` from a view `from` lines back, with a frame every 16 ms, writing `lines`
 * new lines `at` ms after the last event, or before it when negative (through onOutput, or
 * caught up with on the next frame when `quiet`), and returns where the view's top is in
 * the text after each frame.
 */
function play(
  steps: Step[],
  from: number,
  output?: { lines: number; at: number; quiet?: boolean },
) {
  const t = terminal();
  const now = { t: 0 };
  const stream = new WheelStream({ matchMedia: () => ({ matches: false }) });
  const scroll = new SmoothScroll(t.term as unknown as Terminal, stream, {
    window: { devicePixelRatio: 1 },
    performance: { now: () => now.t },
  });
  t.term.viewportY = from;
  t.scrolled(from);
  const times = steps.map((_, i) => 1000 + steps.slice(0, i + 1).reduce((a, s) => a + s.gap, 0));
  const last = times[times.length - 1];
  const writeAt = output && last + output.at;
  const tops: number[] = [];
  const paces: Pace[] = [];
  for (now.t = 990; now.t < last + 600; now.t += 1) {
    steps.forEach((step, i) => {
      if (times[i] !== now.t) return;
      const e = {
        deltaX: 0,
        deltaY: step.deltaY,
        deltaMode: step.deltaMode ?? 0,
        timeStamp: now.t,
      } as WheelEvent;
      paces.push(stream.forScrollback(e));
      scroll.handleWheel(e);
    });
    if (output && now.t === writeAt) {
      t.write(output.lines);
      if (!output.quiet) scroll.onOutput();
    }
    if (now.t % 16 === 0) {
      scroll.frame(now.t);
      tops.push(t.top());
    }
  }
  return { tops, pace: paces.at(-1), term: t.term };
}

describe.each(DEVICES)('%s', (_, steps, motion) => {
  test(`is paced ${motion}`, () => {
    const { pace } = play(steps, 200);
    expect(pace && kind(pace)).toBe(motion);
  });

  /** Halfway through the events, ms after the last one: 0 for a single event. */
  const during = -Math.floor(steps.slice(1).reduce((sum, s) => sum + s.gap, 0) / 2);

  test.each([
    ['after the events, through onOutput', 20, false],
    ['after the events, caught up with on the next frame', 20, true],
    ['during the events, through onOutput', during, false],
    ['during the events, caught up with on the next frame', during, true],
  ])('output %s keeps the text in view and the motion on its way', (_, at, quiet) => {
    const still = play(steps, 200);
    const fed = play(steps, 200, { lines: 7, at, quiet });
    // Frame by frame the view shows the same text, with or without the output
    expect(fed.tops.map((top) => +top.toFixed(6))).toEqual(
      still.tops.map((top) => +top.toFixed(6)),
    );
    expect(fed.term.viewportY).toBe(still.term.viewportY + 7);
  });

  // Output during the events keeps the text, so the rest of the scroll ends short of the
  // bottom, as in Ghostty; output after the last event, which heads for the bottom, does not
  test(
    motion === 'at once'
      ? 'a scroll down applied at once to the bottom follows output after it'
      : 'a glide down to the bottom ends there through output mid-glide',
    () => {
      const down = steps.map((step) => ({ ...step, deltaY: -step.deltaY }));
      // From a little less far back than the scroll goes: its last event heads for the bottom
      const lines = down.reduce(
        (sum, s) => sum + (s.deltaMode === 1 ? s.deltaY : s.deltaY / CELL),
        0,
      );
      const fed = play(down, Math.floor(lines) - 1, { lines: 7, at: 20 });
      expect(fed.term.viewportY).toBe(0);
      expect(fed.tops.at(-1)).toBe(fed.term.scrollback);
    },
  );
});
