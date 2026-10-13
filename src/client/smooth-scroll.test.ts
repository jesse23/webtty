import { describe, expect, test } from 'bun:test';
import {
  SmoothScroll,
  splitScroll,
  WHEEL_GLIDE_MS,
  WheelClassifier,
  wheelLines,
} from './smooth-scroll';
import type { Terminal } from './vendor/ghostty-web';

describe('splitScroll', () => {
  test('a whole-line position has no offset', () => {
    expect(splitScroll(3, 14, 2)).toEqual({ line: 3, offset: 0 });
  });

  test('the fraction becomes a pixel offset below the whole line', () => {
    expect(splitScroll(3.5, 14, 2)).toEqual({ line: 3, offset: 7 });
  });

  test('snaps the offset to device pixels', () => {
    // 0.3 x 14 = 4.2 CSS px = 8.4 device px at 2x, snapped to 8 device px.
    expect(splitScroll(0.3, 14, 2)).toEqual({ line: 0, offset: 4 });
    expect(splitScroll(0.3, 14, 1)).toEqual({ line: 0, offset: 4 });
    expect(splitScroll(0.25, 14, 2)).toEqual({ line: 0, offset: 3.5 });
  });

  test('rounding up to a full cell moves to the next line', () => {
    expect(splitScroll(2.99, 14, 1)).toEqual({ line: 3, offset: 0 });
  });
});

describe('wheelLines', () => {
  test('converts pixel deltas by the cell height', () => {
    expect(wheelLines({ deltaY: 7, deltaMode: 0 }, 14, 40)).toBe(0.5);
    expect(wheelLines({ deltaY: -28, deltaMode: 0 }, 14, 40)).toBe(-2);
  });

  test('passes line deltas through', () => {
    expect(wheelLines({ deltaY: 3, deltaMode: 1 }, 14, 40)).toBe(3);
  });

  test('scales page deltas by the row count', () => {
    expect(wheelLines({ deltaY: -1, deltaMode: 2 }, 14, 40)).toBe(-40);
  });
});

describe('SmoothScroll', () => {
  function fake(cellHeight: number) {
    const metrics = { height: cellHeight };
    const offsets: number[] = [];
    const term = {
      viewportY: 0,
      rows: 40,
      wasmTerm: { isAlternateScreen: () => false },
      renderer: {
        getMetrics: () => metrics,
        setScrollOffset: (offset: number) => offsets.push(offset),
      },
      onScroll: () => {},
      onResize: () => {},
      getScrollbackLength: () => 100,
      scrollToLine(line: number) {
        term.viewportY = line;
      },
    };
    return { term, metrics, offsets, scroll: new SmoothScroll(term as unknown as Terminal) };
  }
  const wheel = (deltaY: number) => ({ deltaY, deltaMode: 0 }) as WheelEvent;

  test('update re-snaps the offset to a new device pixel ratio', () => {
    const g = globalThis as { window?: unknown };
    const saved = g.window;
    try {
      g.window = { devicePixelRatio: 1 };
      const { term, offsets, scroll } = fake(13);
      // 0.69 x 13 = 8.97 CSS px, snapped to 9 at 1x.
      scroll.handleWheel(wheel(-13 * 5.69));
      expect(term.viewportY).toBe(5);
      expect(offsets.at(-1)).toBe(9);
      g.window = { devicePixelRatio: 2 };
      scroll.update();
      expect(offsets.at(-1)).toBe(9);
      g.window = { devicePixelRatio: 1.5 };
      scroll.update();
      // 8.97 x 1.5 = 13.455 device px, snapped to 13.
      expect(offsets.at(-1)).toBeCloseTo(13 / 1.5);
    } finally {
      g.window = saved;
    }
  });

  test('update re-splits the position for a new cell height', () => {
    const g = globalThis as { window?: unknown };
    const saved = g.window;
    try {
      g.window = { devicePixelRatio: 1 };
      const { term, metrics, offsets, scroll } = fake(14);
      // A fractional delta, so the trackpad path applies it at once: 2.518 lines.
      scroll.handleWheel(wheel(-14 * 2.5 - 0.25));
      expect(offsets.at(-1)).toBe(7);
      metrics.height = 20;
      scroll.update();
      expect(term.viewportY).toBe(2);
      expect(offsets.at(-1)).toBe(10);
    } finally {
      g.window = saved;
    }
  });

  describe('mouse wheel glide', () => {
    function withFrames(run: (tick: (ms: number) => void) => void) {
      const g = globalThis as { window?: unknown; performance?: unknown };
      const [savedWindow, savedPerformance] = [g.window, g.performance];
      let now = 0;
      let pending: ((t: number) => void) | null = null;
      g.window = {
        devicePixelRatio: 1,
        requestAnimationFrame: (cb: (t: number) => void) => {
          pending = cb;
          return 1;
        },
        cancelAnimationFrame: () => {
          pending = null;
        },
      };
      g.performance = { now: () => now };
      try {
        run((ms) => {
          now += ms;
          const cb = pending;
          pending = null;
          cb?.(now);
        });
      } finally {
        g.window = savedWindow;
        g.performance = savedPerformance;
      }
    }
    const notch = (deltaY: number) => ({ deltaX: 0, deltaY, deltaMode: 0 }) as WheelEvent;

    test('a notch glides to its target instead of jumping', () => {
      withFrames((tick) => {
        const { term, offsets, scroll } = fake(10);
        scroll.handleWheel(notch(-40));
        expect(term.viewportY).toBe(0);
        expect(offsets).toEqual([]);
        tick(WHEEL_GLIDE_MS / 2);
        // Ease-out cubic at t = 0.5: 0.875 of 4 lines.
        expect(term.viewportY).toBe(3);
        expect(offsets.at(-1)).toBe(5);
        tick(WHEEL_GLIDE_MS);
        expect(term.viewportY).toBe(4);
        expect(offsets.at(-1)).toBe(0);
      });
    });

    test('a notch during a glide adds to its target', () => {
      withFrames((tick) => {
        const { term, scroll } = fake(10);
        scroll.handleWheel(notch(-40));
        tick(WHEEL_GLIDE_MS / 2);
        scroll.handleWheel(notch(-40));
        tick(WHEEL_GLIDE_MS);
        expect(term.viewportY).toBe(8);
      });
    });

    test('line deltas glide too', () => {
      withFrames((tick) => {
        const { term, scroll } = fake(10);
        scroll.handleWheel({ deltaX: 0, deltaY: -3, deltaMode: 1 } as WheelEvent);
        expect(term.viewportY).toBe(0);
        tick(WHEEL_GLIDE_MS);
        expect(term.viewportY).toBe(3);
      });
    });

    test('a trackpad delta stops the glide where it is', () => {
      withFrames((tick) => {
        const { term, offsets, scroll } = fake(10);
        scroll.handleWheel(notch(-40));
        tick(WHEEL_GLIDE_MS / 2);
        scroll.handleWheel({ deltaX: 0.5, deltaY: -0.5, deltaMode: 0 } as WheelEvent);
        const [line, offset] = [term.viewportY, offsets.at(-1)];
        tick(WHEEL_GLIDE_MS);
        expect([term.viewportY, offsets.at(-1)]).toEqual([line, offset]);
      });
    });

    test('the glide stops at the top of scrollback', () => {
      withFrames((tick) => {
        const { term, scroll } = fake(10);
        scroll.handleWheel(notch(-10_000));
        tick(WHEEL_GLIDE_MS);
        expect(term.viewportY).toBe(100);
      });
    });
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
