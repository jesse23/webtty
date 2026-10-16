import { describe, expect, test } from 'bun:test';
import {
  ANSWER_WAIT_MS,
  SLOW_GO_TICKS,
  TickPacer,
  type WheelAccumulator,
  wheelArrowKey,
  wheelArrows,
  wheelTicks,
} from '../../ghostty-web/wheel';

describe('wheelTicks', () => {
  const fresh = (): WheelAccumulator => ({ accum: 0, dir: 0 });
  const PIXEL = 0;
  const LINE = 1;
  const PAGE = 2;

  test('a line delta is one tick per event, down positive and up negative', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 1)).toBe(1);
    expect(wheelTicks(acc, { deltaY: -3, deltaMode: LINE }, 14, 1)).toBe(-1);
  });

  test('a page delta is one tick per event too', () => {
    expect(wheelTicks(fresh(), { deltaY: 1, deltaMode: PAGE }, 14, 1)).toBe(1);
  });

  test('speed above 1 sends several ticks per line event', () => {
    expect(wheelTicks(fresh(), { deltaY: 3, deltaMode: LINE }, 14, 3)).toBe(3);
  });

  test('speed below 1 accumulates across events', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 0.5)).toBe(0);
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 0.5)).toBe(1);
    expect(wheelTicks(acc, { deltaY: 3, deltaMode: LINE }, 14, 0.5)).toBe(0);
  });

  test('pixel deltas count one tick per cell height, ignoring speed', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 7, deltaMode: PIXEL }, 14, 3)).toBe(0);
    expect(wheelTicks(acc, { deltaY: 7, deltaMode: PIXEL }, 14, 3)).toBe(1);
    expect(wheelTicks(acc, { deltaY: -42, deltaMode: PIXEL }, 14, 3)).toBe(-3);
  });

  test('a direction change drops the remainder', () => {
    const acc = fresh();
    expect(wheelTicks(acc, { deltaY: 10, deltaMode: PIXEL }, 14, 1)).toBe(0);
    expect(wheelTicks(acc, { deltaY: -10, deltaMode: PIXEL }, 14, 1)).toBe(0);
    expect(wheelTicks(acc, { deltaY: -4, deltaMode: PIXEL }, 14, 1)).toBe(-1);
    expect(wheelTicks(acc, { deltaY: 10, deltaMode: PIXEL }, 14, 1)).toBe(0);
  });
});

describe('wheelArrows', () => {
  const acc = (): WheelAccumulator => ({ accum: 0, dir: 0 });

  test('slow trackpad deltas add up to one arrow per line', () => {
    const a = acc();
    const sent = [3, 3, 3, 3, 3, 3].map((d) => wheelArrows(a, { deltaY: d, deltaMode: 0 }, 17, 40));
    expect(sent).toEqual([0, 0, 0, 0, 0, 1]);
  });

  test('a Firefox notch of 3 lines sends 3 arrows', () => {
    expect(wheelArrows(acc(), { deltaY: -3, deltaMode: 1 }, 17, 40)).toBe(-3);
  });

  test('a large delta is not capped', () => {
    expect(wheelArrows(acc(), { deltaY: 340, deltaMode: 0 }, 17, 40)).toBe(20);
  });

  test('page deltas scale by rows, and a direction change drops the remainder', () => {
    const a = acc();
    expect(wheelArrows(a, { deltaY: 1, deltaMode: 2 }, 17, 40)).toBe(40);
    expect(wheelArrows(a, { deltaY: 10, deltaMode: 0 }, 17, 40)).toBe(0);
    expect(wheelArrows(a, { deltaY: -10, deltaMode: 0 }, 17, 40)).toBe(0);
  });
});

describe('TickPacer', () => {
  /**
   * Runs `run` on fake frames. With `answers` (the default) the app answers every frame, as
   * one that redraws within a frame does; without it, only when the test calls `answered`.
   */
  function frames(
    run: (pacer: TickPacer, sent: string[], tick: (ms: number) => void) => void,
    answers = true,
  ) {
    const g = globalThis as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
      performance?: unknown;
    };
    const saved = [g.requestAnimationFrame, g.cancelAnimationFrame, g.performance];
    let now = 0;
    let pending: ((t: number) => void) | null = null;
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      pending = cb;
      return 1;
    };
    g.cancelAnimationFrame = () => {
      pending = null;
    };
    g.performance = { now: () => now };
    const sent: string[] = [];
    try {
      const pacer = new TickPacer((d) => sent.push(d));
      run(pacer, sent, (ms) => {
        if (answers) pacer.answered();
        now += ms;
        const cb = pending;
        pending = null;
        cb?.(now);
      });
    } finally {
      [g.requestAnimationFrame, g.cancelAnimationFrame, g.performance] = saved;
    }
  }

  test('the first tick goes out on the first frame', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 1, { duration: 125 });
      tick(1000 / 60);
      expect(sent).toEqual(['A']);
    });
  });

  test('with a spring, ticks follow it and all arrive', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 20, { duration: 125, omega: 28 });
      const perFrame: number[] = [];
      for (let i = 0; i < 30; i++) {
        const before = sent.join('').length;
        tick(1000 / 60);
        perFrame.push(sent.join('').length - before);
      }
      expect(sent.join('').length).toBe(20);
      // Spread over several frames, not sent at once.
      expect(Math.max(...perFrame)).toBeLessThan(10);
    });
  });

  test('a zero duration sends the ticks at once', () => {
    frames((pacer, sent) => {
      pacer.push('A', -1, 3, { duration: 0 });
      expect(sent).toEqual(['AAA']);
    });
  });

  test('spreads ticks evenly over the duration, a few per frame', () => {
    frames((pacer, sent, tick) => {
      // 12 ticks over 50 ms, starting a frame early: 4 per 16.7 ms frame, so the
      // first frame sends 8 and the next the last 4.
      pacer.push('A', -1, 12, { duration: 50 });
      expect(sent).toEqual([]);
      tick(1000 / 60);
      expect(sent).toEqual(['A'.repeat(8)]);
      tick(1000 / 60);
      expect(sent).toEqual(['A'.repeat(8), 'A'.repeat(4)]);
    });
  });

  test('a new event joins the ticks still queued', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 6, { duration: 50 });
      tick(1000 / 60);
      pacer.push('B', -1, 6, { duration: 50 });
      for (let i = 0; i < 6; i++) tick(1000 / 60);
      const all = sent.join('');
      expect(all.length).toBe(12);
      // Queued ticks go out with the latest event's sequence.
      expect(all.endsWith('B')).toBe(true);
    });
  });

  test('a zero-duration event flushes the queued ticks first', () => {
    frames((pacer, sent) => {
      pacer.push('A', 1, 6, { duration: 50 });
      pacer.push('B', 1, 2, { duration: 0 });
      expect(sent).toEqual(['BBBBBBBB']);
    });
  });

  test('a direction change drops the queued ticks', () => {
    frames((pacer, sent, tick) => {
      pacer.push('A', -1, 10, { duration: 100 });
      tick(1000 / 60);
      const before = sent.join('').length;
      pacer.answered();
      pacer.push('B', 1, 1, { duration: 0 });
      expect(sent.join('').length).toBe(before + 1);
      expect(sent.at(-1)).toBe('B');
      tick(1000 / 60);
      tick(100);
      expect(sent.at(-1)).toBe('B');
    });
  });
});

describe('TickPacer waiting for the app', () => {
  function slowApp(run: (pacer: TickPacer, sent: string[], tick: (ms: number) => void) => void) {
    const g = globalThis as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
      performance?: unknown;
    };
    const saved = [g.requestAnimationFrame, g.cancelAnimationFrame, g.performance];
    let now = 0;
    let pending: ((t: number) => void) | null = null;
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      pending = cb;
      return 1;
    };
    g.cancelAnimationFrame = () => {
      pending = null;
    };
    g.performance = { now: () => now };
    const sent: string[] = [];
    try {
      run(new TickPacer((d) => sent.push(d)), sent, (ms) => {
        now += ms;
        const cb = pending;
        pending = null;
        cb?.(now);
      });
    } finally {
      [g.requestAnimationFrame, g.cancelAnimationFrame, g.performance] = saved;
    }
  }
  const frame = 1000 / 60;

  test('ticks due while the app redraws go together once it answers', () => {
    slowApp((pacer, sent, tick) => {
      // 12 ticks over 200 ms, about one a frame, to an app that takes 100 ms a redraw
      pacer.push('A', -1, 12, { duration: 200 });
      tick(frame);
      expect(sent).toHaveLength(1);
      for (let i = 0; i < 5; i++) tick(frame);
      expect(sent).toHaveLength(1);
      pacer.answered();
      tick(frame);
      expect(sent).toHaveLength(2);
      // The second go carries every tick due during the wait
      expect(sent[1].length).toBeGreaterThan(1);
      for (let i = 0; i < 20; i++) {
        if (i % 6 === 5) pacer.answered();
        tick(frame);
      }
      expect(sent.join('').length).toBe(12);
      // A few goes for twelve ticks, not twelve
      expect(sent.length).toBeLessThanOrEqual(5);
    });
  });

  test('ticks due at once wait for the answer too', () => {
    slowApp((pacer, sent, tick) => {
      pacer.push('A', -1, 2, { duration: 0 });
      pacer.push('A', -1, 3, { duration: 0 });
      expect(sent).toEqual(['AA']);
      tick(frame);
      expect(sent).toEqual(['AA']);
      pacer.answered();
      tick(frame);
      expect(sent).toEqual(['AA', 'AAA']);
    });
  });

  test('a slow app gets at most SLOW_GO_TICKS a go, and ticks past one more go are dropped', () => {
    slowApp((pacer, sent, tick) => {
      // Two goes answered after 60 ms: the app is slow
      for (let i = 0; i < 2; i++) {
        pacer.push('A', -1, 1, { duration: 0 });
        tick(60);
        pacer.answered();
      }
      sent.length = 0;
      pacer.push('A', -1, 50, { duration: 0 });
      expect(sent).toEqual(['A'.repeat(SLOW_GO_TICKS)]);
      tick(60);
      pacer.answered();
      tick(frame);
      // One more go of the rest; the other 26 are dropped
      expect(sent).toEqual(['A'.repeat(SLOW_GO_TICKS), 'A'.repeat(SLOW_GO_TICKS)]);
      tick(60);
      pacer.answered();
      for (let i = 0; i < 5; i++) tick(frame);
      expect(sent).toHaveLength(2);
    });
  });

  test('a fast app gets every tick due, however many', () => {
    slowApp((pacer, sent, tick) => {
      for (let i = 0; i < 3; i++) {
        pacer.push('A', -1, 1, { duration: 0 });
        tick(10);
        pacer.answered();
      }
      sent.length = 0;
      pacer.push('A', -1, 50, { duration: 0 });
      expect(sent).toEqual(['A'.repeat(50)]);
    });
  });

  test('an app that does not answer gets the next ticks after ANSWER_WAIT_MS', () => {
    slowApp((pacer, sent, tick) => {
      pacer.push('A', -1, 1, { duration: 0 });
      pacer.push('A', -1, 1, { duration: 0 });
      tick(ANSWER_WAIT_MS - 10);
      expect(sent).toEqual(['A']);
      tick(20);
      expect(sent).toEqual(['A', 'A']);
    });
  });
});

describe('wheelArrowKey', () => {
  test('normal cursor keys are ESC [ A/B', () => {
    expect(wheelArrowKey(-1, false)).toBe('\x1b[A');
    expect(wheelArrowKey(1, false)).toBe('\x1b[B');
  });

  test('application cursor keys (DECCKM), as less sets, are ESC O A/B', () => {
    expect(wheelArrowKey(-1, true)).toBe('\x1bOA');
    expect(wheelArrowKey(1, true)).toBe('\x1bOB');
  });
});
