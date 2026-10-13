import { describe, expect, test } from 'bun:test';
import {
  SmoothScroll,
  STREAM_OMEGA,
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

/** Scrolls made by `fake`, whose `frame` the render loop stand-in calls. */
const live: SmoothScroll[] = [];

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
    const scroll = new SmoothScroll(term as unknown as Terminal);
    live.push(scroll);
    return { term, metrics, offsets, scroll };
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
      g.window = { devicePixelRatio: 1 };
      g.performance = { now: () => now };
      live.length = 0;
      try {
        // One frame of the render loop, `ms` after the last.
        run((ms) => {
          now += ms;
          for (const scroll of live) scroll.frame(now);
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
        // The glide starts a frame before the event, so after 62.5 ms t = 79.2 / 125;
        // ease-out cubic gives 0.95 of 4 lines.
        expect(term.viewportY).toBe(3);
        expect(offsets.at(-1)).toBe(8);
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

    test('with reduced motion a notch scrolls at once', () => {
      withFrames(() => {
        const g = globalThis as { matchMedia?: unknown };
        const saved = g.matchMedia;
        g.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' });
        try {
          const { term, scroll } = fake(10);
          scroll.handleWheel(notch(-40));
          expect(term.viewportY).toBe(4);
          expect(scroll.tickSpread(notch(-40)).duration).toBe(0);
          // A sparse stream's ticks to an app are still paced: that times input, it
          // does not animate.
          const point = (deltaY: number, timeStamp: number) =>
            ({ deltaX: 0, deltaY, deltaMode: 0, timeStamp }) as WheelEvent;
          scroll.tickSpread(point(-95.5, 4000));
          expect(scroll.tickSpread(point(-97.25, 4040)).duration).toBeGreaterThan(0);
        } finally {
          g.matchMedia = saved;
        }
      });
    });

    test('a glide is not stopped by its own move onto the next line', () => {
      withFrames((tick) => {
        const { term, offsets, scroll } = fake(10);
        // ghostty-web fires onScroll synchronously from scrollToLine.
        let onScroll = (_y: number) => {};
        const t = term as unknown as { onScroll: unknown; scrollToLine: (l: number) => void };
        const real = t.scrollToLine;
        t.scrollToLine = (l: number) => {
          real(l);
          onScroll(l);
        };
        const s = new SmoothScroll({
          ...term,
          onScroll: (cb: (y: number) => void) => {
            onScroll = cb;
          },
        } as unknown as Terminal);
        live.push(s);
        void scroll;
        // Frames 0.5 ms apart are sure to land within 0.05 lines below a line, where the
        // offset rounds up to the next line.
        s.handleWheel(notch(-40));
        for (let i = 0; i < 300; i++) tick(0.5);
        expect([term.viewportY, offsets.at(-1)]).toEqual([4, 0]);
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

    test('a trackpad delta finishes the glide and applies at once', () => {
      withFrames((tick) => {
        const { term, offsets, scroll } = fake(10);
        scroll.handleWheel({ ...notch(-40), timeStamp: 1000 } as WheelEvent);
        tick(WHEEL_GLIDE_MS / 2);
        scroll.handleWheel({
          deltaX: 0.5,
          deltaY: -5.5,
          deltaMode: 0,
          timeStamp: 1008,
        } as WheelEvent);
        expect([term.viewportY, offsets.at(-1)]).toEqual([4, 5]);
        tick(WHEEL_GLIDE_MS);
        expect([term.viewportY, offsets.at(-1)]).toEqual([4, 5]);
      });
    });

    // Deltas from the capture of a TrackPoint in Chrome on macOS.
    const point = (deltaY: number, timeStamp: number) =>
      ({ deltaX: 0, deltaY, deltaMode: 0, timeStamp }) as WheelEvent;

    test('a sparse stream glides each delta over the time it took to arrive', () => {
      withFrames((tick) => {
        const { term, offsets, scroll } = fake(10);
        scroll.handleWheel(point(-4.000244140625, 1000));
        scroll.handleWheel(point(-95.0897216796875, 1040));
        // The slow 4.000244 px steps count as wheel notches and glide to 0.4 lines. The
        // fast delta, 9.51 lines more, glides linearly from where the first glide is,
        // before its first frame, over its 40 ms gap plus a frame, starting a frame
        // early: after 20 ms, t = 36.7 / 56.7, 6.41 lines.
        tick(20);
        expect([term.viewportY, offsets.at(-1)]).toEqual([6, 4]);
        tick(20);
        expect([term.viewportY, offsets.at(-1)]).toEqual([9, 9]);
      });
    });

    test('a slow sparse stream glides for at most the wheel glide time', () => {
      withFrames((tick) => {
        const { term, scroll } = fake(10);
        scroll.handleWheel(point(-4.000244140625, 1000));
        scroll.handleWheel(point(-40.0001, 1300));
        tick(WHEEL_GLIDE_MS);
        expect(term.viewportY).toBe(4);
      });
    });

    test('trackpad deltas a frame apart apply at once', () => {
      withFrames(() => {
        const { term, scroll } = fake(10);
        scroll.handleWheel(point(-20.5, 1000));
        scroll.handleWheel(point(-21.25, 1008));
        expect(term.viewportY).toBe(4);
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

describe('SmoothScroll.tickSpread', () => {
  const scroll = () =>
    new SmoothScroll({ onScroll: () => {}, onResize: () => {} } as unknown as Terminal);
  const at = (deltaY: number, timeStamp: number, deltaMode = 0) =>
    ({ deltaX: 0, deltaY, deltaMode, timeStamp }) as WheelEvent;

  test('spreads a sparse delta over its gap plus a frame', () => {
    const s = scroll();
    s.tickSpread(at(-4.000244140625, 1000));
    expect(s.tickSpread(at(-95.0897216796875, 1040)).duration).toBeCloseTo(40 + 1000 / 60);
  });

  test('caps the spread at the wheel glide time', () => {
    const s = scroll();
    s.tickSpread(at(-4.000244140625, 1000));
    expect(s.tickSpread(at(-30.25, 1200)).duration).toBe(WHEEL_GLIDE_MS);
  });

  test('spreads a wheel notch over the wheel glide time', () => {
    expect(scroll().tickSpread(at(-3, 1000, 1)).duration).toBe(WHEEL_GLIDE_MS);
  });

  test('a sparse stream stays paced through one short gap', () => {
    const s = scroll();
    s.tickSpread(at(-23.5, 1000));
    expect(s.tickSpread(at(-63.25, 1040)).duration).toBeCloseTo(40 + 1000 / 60);
    // The capture's 25 ms gap replays as 24.9 ms.
    expect(s.tickSpread(at(-95.5, 1064.9)).duration).toBeCloseTo(24.9 + 1000 / 60);
    expect(s.tickSpread(at(-120.75, 1100)).duration).toBeCloseTo(35.1 + 1000 / 60);
  });

  test('a wheel notch soon after one in the same direction continues linearly', () => {
    const s = scroll();
    expect(s.tickSpread(at(-3, 1000, 1)).duration).toBe(WHEEL_GLIDE_MS);
    expect(s.tickSpread(at(-3, 1150, 1)).duration).toBeCloseTo(150 + 1000 / 60);
    // Reversing, or after a pause, a notch eases out again.
    expect(s.tickSpread(at(3, 1200, 1)).duration).toBe(WHEEL_GLIDE_MS);
    expect(s.tickSpread(at(3, 1500, 1)).duration).toBe(WHEEL_GLIDE_MS);
  });

  test('a fast sparse stream follows a spring', () => {
    const s = scroll();
    let t = 1000;
    s.tickSpread(at(-23.5, t));
    const paces = [40, 35, 30, 45, 33, 38, 31].map((gap, i) => {
      t += gap;
      return s.tickSpread(at(-(100.5 + i * 1.25), t));
    });
    // The pause before the stream counts as a slow gap, so it starts linear and
    // turns into a spring once the average gap drops under 60 ms.
    expect(paces[0].omega).toBeUndefined();
    expect(paces.at(-1)?.omega).toBe(STREAM_OMEGA);
  });

  test('sends trackpad deltas at once', () => {
    const s = scroll();
    s.tickSpread(at(-20.5, 1200));
    s.tickSpread(at(-21.25, 1208));
    // Two short gaps in a row end the sparse stream a gesture starts as.
    expect(s.tickSpread(at(-22.75, 1216)).duration).toBe(0);
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
