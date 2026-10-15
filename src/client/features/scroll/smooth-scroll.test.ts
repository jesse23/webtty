import { beforeEach, describe, expect, test } from 'bun:test';
import type { Terminal } from '../../vendor/ghostty-web';
import { SmoothScroll } from './smooth-scroll';
import { WHEEL_GLIDE_MS, WheelStream } from './wheel-stream';

/** Scrolls made by `fake`, whose `frame` the render loop stand-in calls. */
const live: SmoothScroll[] = [];

/** The device pixel ratio, clock and reduced-motion setting the fakes are given. */
const env = { dpr: 1, now: 0, reducedMotion: false };

describe('SmoothScroll', () => {
  function fake(cellHeight: number) {
    const metrics = { height: cellHeight };
    const offsets: number[] = [];
    let scrolled = (_y: number) => {};
    let resized = () => {};
    const unsubscribed: string[] = [];
    const term = {
      viewportY: 0,
      scrollback: 100,
      rows: 40,
      wasmTerm: { isAlternateScreen: () => false },
      renderer: {
        getMetrics: () => metrics,
        setScrollOffset: (offset: number) => offsets.push(offset),
      },
      onScroll: (cb: (y: number) => void) => {
        scrolled = cb;
        return { dispose: () => unsubscribed.push('onScroll') };
      },
      onResize: (cb: () => void) => {
        resized = cb;
        return { dispose: () => unsubscribed.push('onResize') };
      },
      getScrollbackLength: () => term.scrollback,
      scrollToLine(line: number) {
        term.viewportY = line;
      },
    };
    const stream = new WheelStream({
      matchMedia: (q) => ({
        matches: env.reducedMotion && q === '(prefers-reduced-motion: reduce)',
      }),
    });
    const scroll = new SmoothScroll(term as unknown as Terminal, stream, {
      window: {
        get devicePixelRatio() {
          return env.dpr;
        },
      },
      performance: { now: () => env.now },
    });
    live.push(scroll);
    return {
      term,
      metrics,
      offsets,
      scroll,
      unsubscribed,
      scrolled: (y: number) => scrolled(y),
      resized: () => resized(),
    };
  }
  const wheel = (deltaY: number) => ({ deltaY, deltaMode: 0 }) as WheelEvent;

  beforeEach(() => {
    Object.assign(env, { dpr: 1, now: 0, reducedMotion: false });
    live.length = 0;
  });

  test('dispose drops its scroll and resize subscriptions; twice is a no-op', () => {
    const { scroll, unsubscribed } = fake(10);
    scroll.dispose();
    scroll.dispose();
    expect(unsubscribed.sort()).toEqual(['onResize', 'onScroll']);
  });

  test('update re-snaps the offset to a new device pixel ratio', () => {
    const { term, offsets, scroll } = fake(13);
    // 0.69 x 13 = 8.97 CSS px, snapped to 9 at 1x.
    scroll.handleWheel(wheel(-13 * 5.69));
    expect(term.viewportY).toBe(5);
    expect(offsets.at(-1)).toBe(9);
    env.dpr = 2;
    scroll.update();
    expect(offsets.at(-1)).toBe(9);
    env.dpr = 1.5;
    scroll.update();
    // 8.97 x 1.5 = 13.455 device px, snapped to 13.
    expect(offsets.at(-1)).toBeCloseTo(13 / 1.5);
  });

  test('a zero device pixel ratio counts as 1x', () => {
    const { offsets, scroll } = fake(13);
    env.dpr = 0;
    scroll.handleWheel(wheel(-13 * 5.69));
    expect(offsets.at(-1)).toBe(9);
  });

  test('update re-splits the position for a new cell height', () => {
    const { term, metrics, offsets, scroll } = fake(14);
    // A fractional delta, so the trackpad path applies it at once: 2.518 lines.
    scroll.handleWheel(wheel(-14 * 2.5 - 0.25));
    expect(offsets.at(-1)).toBe(7);
    metrics.height = 20;
    scroll.update();
    expect(term.viewportY).toBe(2);
    expect(offsets.at(-1)).toBe(10);
  });

  test('less than a line up, output keeps the text in view (ADR 066)', () => {
    const { term, offsets, scroll } = fake(10);
    // 0.625 lines (a trackpad delta): line 0 with a 6.25 px offset, rounded to 6.
    scroll.handleWheel(wheel(-6.25));
    expect([term.viewportY, offsets.at(-1)]).toEqual([0, 6]);
    // A redraw in place moves nothing
    scroll.onOutput();
    expect(offsets).toEqual([6]);
    // Three new lines: ghostty-web pinned the part row in view and moved the view up by three
    term.scrollback += 3;
    term.viewportY = 3;
    scroll.onOutput();
    expect([term.viewportY, offsets.at(-1)]).toEqual([3, 6]);
  });

  test('a view ghostty-web kept on its text moves the glide by as much, keeping its offset (ADR 066)', () => {
    const { term, offsets, scroll } = fake(10);
    scroll.handleWheel(wheel(-25.75));
    expect([term.viewportY, offsets.at(-1)]).toEqual([2, 6]);
    // A redraw in place: the view stays.
    scroll.onOutput();
    expect([term.viewportY, offsets.at(-1)]).toEqual([2, 6]);
    // Four new lines, or four after rows pruned at the limit: ghostty-web moved its view up by four.
    term.viewportY = 6;
    scroll.onOutput();
    expect([term.viewportY, offsets.at(-1)]).toEqual([6, 6]);
    // The next wheel step goes on from there, not from where the glide was.
    scroll.handleWheel(wheel(-10));
    expect([term.viewportY, offsets.at(-1)]).toEqual([7, 6]);
  });

  test('a write without onOutput (a status line) is caught up with on the next frame or wheel event', () => {
    const { term, offsets, scroll } = fake(10);
    scroll.handleWheel(wheel(-25.75));
    term.viewportY = 5;
    scroll.frame(16);
    expect([term.viewportY, offsets.at(-1)]).toEqual([5, 6]);
    term.viewportY = 8;
    scroll.handleWheel(wheel(-10));
    expect([term.viewportY, offsets.at(-1)]).toEqual([9, 6]);
  });

  test('a cleared scrollback, or one that shrank under a sub-line offset, brings the glide to the bottom', () => {
    const { term, offsets, scroll } = fake(10);
    scroll.handleWheel(wheel(-25.75));
    term.scrollback = 0;
    term.viewportY = 0;
    scroll.onOutput();
    expect([term.viewportY, offsets.at(-1)]).toEqual([0, 0]);
    term.scrollback = 100;
    scroll.handleWheel(wheel(-6.25));
    term.scrollback = 0;
    scroll.onOutput();
    expect([term.viewportY, offsets.at(-1)]).toEqual([0, 0]);
  });

  test('a key at a sub-line offset (scrollToBottom announced from line 0) drops the offset', () => {
    const { term, offsets, scroll, scrolled } = fake(10);
    scroll.handleWheel(wheel(-6.25));
    scrolled(0);
    expect([term.viewportY, offsets.at(-1)]).toEqual([0, 0]);
  });

  test('at rest on the bottom, output changes nothing', () => {
    const { term, offsets, scroll } = fake(10);
    term.scrollback += 3;
    scroll.onOutput();
    expect([term.viewportY, offsets]).toEqual([0, []]);
  });

  test("follows ghostty-web's own moves of the viewport, and resizes", () => {
    const { term, offsets, scroll, scrolled, resized } = fake(10);
    scroll.handleWheel(wheel(-25.75));
    // A keyboard scroll to line 7.
    term.viewportY = 7;
    scrolled(7);
    expect(offsets.at(-1)).toBe(0);
    // Its own line is not a move to follow.
    offsets.length = 0;
    scrolled(7);
    expect(offsets).toEqual([]);
    term.viewportY = 3;
    resized();
    expect([term.viewportY, offsets.at(-1)]).toEqual([3, 0]);
  });

  test('leaves the alternate screen, and a terminal without a renderer, to ghostty-web', () => {
    const alt = fake(10);
    alt.term.wasmTerm.isAlternateScreen = () => true;
    expect(alt.scroll.handleWheel(wheel(-40))).toBe(false);
    const bare = fake(10);
    (bare.term as { renderer?: unknown }).renderer = undefined;
    expect(bare.scroll.handleWheel(wheel(-40))).toBe(false);
    bare.scroll.update();
    bare.scroll.frame(16);
  });

  describe('mouse wheel glide', () => {
    function withFrames(run: (tick: (ms: number) => void) => void) {
      // One frame of the render loop, `ms` after the last.
      run((ms) => {
        env.now += ms;
        for (const scroll of live) scroll.frame(env.now);
      });
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
        env.reducedMotion = true;
        const { term, scroll } = fake(10);
        scroll.handleWheel(notch(-40));
        expect(term.viewportY).toBe(4);
      });
    });

    test('a glide is not stopped by its own move onto the next line', () => {
      withFrames((tick) => {
        const { term, offsets, scroll, scrolled } = fake(10);
        // ghostty-web fires onScroll synchronously from scrollToLine.
        const real = term.scrollToLine;
        term.scrollToLine = (line: number) => {
          real(line);
          scrolled(line);
        };
        // Frames 0.5 ms apart are sure to land within 0.05 lines below a line, where the
        // offset rounds up to the next line.
        scroll.handleWheel(notch(-40));
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
