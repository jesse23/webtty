import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { ManualClock } from '../../../test-support/manual-clock';
import { recordListeners } from '../../../test-support/recording-target';
import type { ScrollbarHost } from '../../ghostty-web/core/host-types';
import {
  browserScrollbarClock,
  ScrollbarController,
} from '../../ghostty-web/core/scrollbar-controller';
import {
  SCROLLBAR_FADE_DURATION_MS,
  SCROLLBAR_HIDE_DELAY_MS,
} from '../../ghostty-web/core/terminal-constants';
import {
  scrollbarThumbHeight,
  scrollbarThumbY,
  scrollbarTrackHeight,
  scrollbarX,
} from '../../ghostty-web/render/scrollbar-geometry';

// The scrollbar's press, drag and fade, on a happy-dom container and canvas 800 x 400 px at
// the page origin, a terminal of 24 rows over 100 lines of scrollback, and a hand-run clock.

const RECT = { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 };
const ROWS = 24;
const TRACK = scrollbarTrackHeight(RECT.height);
const THUMB = scrollbarThumbHeight(ROWS, 100, TRACK);
/** The middle of the scrollbar's column. */
const COLUMN_X = scrollbarX(RECT.width) + 4;

let dom: DomWindow | undefined;
afterEach(async () => {
  await dom?.close();
  dom = undefined;
});

function scrollbar(options: { scrollback?: number; opened?: boolean; scrollOffset?: number } = {}) {
  dom = createDomWindow();
  const { document, window } = dom;
  const container = document.createElement('div');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  document.body.appendChild(container);
  canvas.getBoundingClientRect = () => RECT as DOMRect;
  const clock = new ManualClock();
  const state = { viewportY: 0, scrollback: options.scrollback ?? 100 };
  const lines: number[] = [];
  const renders: number[] = [];
  const opened = options.opened ?? true;
  const host: ScrollbarHost = {
    canvas: () => (opened ? canvas : undefined),
    scrollOffset: () => (opened ? (options.scrollOffset ?? 0) : undefined),
    getScrollbackLength: () => state.scrollback,
    rows: () => ROWS,
    viewportY: () => state.viewportY,
    scrollToLine: (line) => {
      lines.push(line);
      state.viewportY = line;
    },
    render: (opacity) => void renders.push(opacity),
  };
  const bar = new ScrollbarController(host, clock);
  bar.attach(container);
  bar.watchRelease(document);
  // A listener added after the scrollbar's, as SelectionManager's is
  const later: string[] = [];
  container.addEventListener('mousedown', () => later.push('selection'), { capture: true });
  const press = (clientX: number, clientY: number) => {
    const event = new window.MouseEvent('mousedown', {
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    });
    canvas.dispatchEvent(event);
    return event;
  };
  const move = (clientY: number) =>
    new window.MouseEvent('mousemove', { clientX: COLUMN_X, clientY });
  const release = () => document.dispatchEvent(new window.MouseEvent('mouseup'));
  return { bar, clock, state, lines, renders, later, press, move, release, canvas };
}

describe('ScrollbarController press', () => {
  test('a press outside its column is left to the others', () => {
    const { press, lines, later } = scrollbar();
    const event = press(100, 200);
    expect([event.defaultPrevented, lines, later]).toEqual([false, [], ['selection']]);
  });

  test('a press on the track jumps there and nobody else sees it', () => {
    const { press, lines, later } = scrollbar();
    // The top of the track is the start of the scrollback
    const event = press(COLUMN_X, 4);
    expect([event.defaultPrevented, lines, later]).toEqual([true, [100], []]);
    // Halfway down the track is halfway
    press(COLUMN_X, 4 + TRACK / 2);
    expect(lines).toEqual([100, 50]);
  });

  test('the press is measured from the rows in view, below the scroll offset (ADR 043)', () => {
    const { press, lines } = scrollbar({ scrollOffset: 6 });
    press(COLUMN_X, 10);
    expect(lines).toEqual([100]);
  });

  test('without scrollback, or before open(), a press does nothing', () => {
    for (const options of [{ scrollback: 0 }, { opened: false }]) {
      const { press, lines, later } = scrollbar(options);
      press(COLUMN_X, 4);
      expect([lines, later]).toEqual([[], ['selection']]);
    }
  });
});

describe('ScrollbarController drag', () => {
  test('a press on the thumb drags it, moving the view by the thumb travel', () => {
    const { bar, press, move, release, lines, canvas } = scrollbar();
    const thumbY = scrollbarThumbY(0, 100, TRACK, THUMB);
    press(COLUMN_X, thumbY + 10);
    expect(lines).toEqual([]);
    expect(canvas.style.userSelect).toBe('none');
    // A tenth of the travel up is a tenth of the scrollback back
    expect(bar.drag(move(thumbY + 10 - (TRACK - THUMB) / 10))).toBe(true);
    expect(lines).toEqual([10]);
    // Past the end, the view stays at the bottom
    bar.drag(move(thumbY + 500));
    expect(lines).toEqual([10, 0]);
    release();
    expect(canvas.style.userSelect).toBe('');
    expect(bar.drag(move(0))).toBe(false);
  });

  test('a release with no drag, and a drag with nothing open, do nothing', () => {
    const { bar, release, move, lines } = scrollbar({ opened: false });
    release();
    expect(bar.drag(move(0))).toBe(false);
    expect(lines).toEqual([]);
  });

  test('a drag holds the scrollbar shown; the release hides it after the pause', () => {
    const { bar, press, release, clock, renders } = scrollbar();
    bar.show();
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    press(COLUMN_X, scrollbarThumbY(0, 100, TRACK, THUMB) + 1);
    bar.show();
    clock.advance(SCROLLBAR_HIDE_DELAY_MS * 2);
    expect(bar.opacity).toBe(1);
    release();
    clock.advance(SCROLLBAR_HIDE_DELAY_MS);
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    expect([bar.opacity, renders[renders.length - 1]]).toEqual([0, 0]);
  });
});

describe('ScrollbarController fade', () => {
  test('show() fades in over the fade time, rendering each frame', () => {
    const { bar, clock, renders } = scrollbar();
    bar.show();
    expect([bar.opacity, renders]).toEqual([0, [0]]);
    clock.frame(SCROLLBAR_FADE_DURATION_MS / 2);
    expect(bar.opacity).toBe(0.5);
    clock.frame(SCROLLBAR_FADE_DURATION_MS / 2);
    expect(renders).toEqual([0, 0.5, 1]);
    // The fade is over: no frame is waiting
    expect(clock.pending.frames).toBe(0);
  });

  test('after the pause it fades out from where it is, then renders once more at 0', () => {
    const { bar, clock, renders } = scrollbar();
    bar.show();
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    renders.length = 0;
    clock.advance(SCROLLBAR_HIDE_DELAY_MS - SCROLLBAR_FADE_DURATION_MS);
    expect(renders).toEqual([1]);
    clock.frame(SCROLLBAR_FADE_DURATION_MS / 2);
    clock.frame(SCROLLBAR_FADE_DURATION_MS / 2);
    expect(renders).toEqual([1, 0.5, 0, 0]);
    expect(bar.opacity).toBe(0);
  });

  test('another scroll while shown keeps it opaque and starts the pause again', () => {
    const { bar, clock } = scrollbar();
    bar.show();
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    clock.advance(SCROLLBAR_HIDE_DELAY_MS - 300);
    bar.show();
    clock.advance(SCROLLBAR_HIDE_DELAY_MS - 100);
    expect(bar.opacity).toBe(1);
    expect(clock.pending.frames).toBe(0);
    clock.advance(100);
    expect(clock.pending.frames).toBe(1);
  });

  test('a show during the fade in keeps fading in, then holds at 1', () => {
    const { bar, clock } = scrollbar();
    bar.show();
    bar.show();
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    expect(bar.opacity).toBe(1);
  });
});

describe('ScrollbarController teardown', () => {
  test('dispose() removes the press and the pending hide; again does nothing', () => {
    const { bar, clock, press, lines } = scrollbar();
    bar.show();
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    bar.dispose();
    bar.dispose();
    press(COLUMN_X, 4);
    expect(lines).toEqual([]);
    clock.advance(SCROLLBAR_HIDE_DELAY_MS);
    expect([bar.opacity, clock.pending]).toEqual([1, { timers: 0, frames: 0 }]);
  });

  test('dispose() removes the document mouseup too, with its flags (ADR 065)', () => {
    dom = createDomWindow();
    const doc = recordListeners(dom.document, 'document');
    const bar = new ScrollbarController(idleHost(), new ManualClock());
    // Watching before attach() still has a store to go in
    bar.watchRelease(doc);
    bar.dispose();
    expect(doc.active).toEqual([]);
    expect(doc.removed).toEqual(doc.added);
    // After dispose(), watching again starts a new store, which a second dispose() releases
    bar.watchRelease(doc);
    expect(doc.active.map((r) => r.type)).toEqual(['mouseup']);
    bar.dispose();
    expect(doc.active).toEqual([]);
  });

  test('dispose() cancels the next frame of every fade still running (ADR 065)', () => {
    const { bar, clock, renders } = scrollbar();
    bar.show();
    expect(clock.pending.frames).toBe(1);
    bar.dispose();
    const rendered = renders.length;
    clock.frame(SCROLLBAR_FADE_DURATION_MS);
    expect([clock.pending, renders.length]).toEqual([{ timers: 0, frames: 0 }, rendered]);
  });
});

/** A host with no canvas and no scrollback. */
function idleHost(): ScrollbarHost {
  return {
    canvas: () => undefined,
    scrollOffset: () => undefined,
    getScrollbackLength: () => 0,
    rows: () => 1,
    viewportY: () => 0,
    scrollToLine: () => {},
    render: () => {},
  };
}

test('the browser clock cancels a frame on the global cancelAnimationFrame', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.cancelAnimationFrame;
  const cancelled: number[] = [];
  g.cancelAnimationFrame = (id: number) => void cancelled.push(id);
  try {
    browserScrollbarClock.cancelAnimationFrame(7);
  } finally {
    g.cancelAnimationFrame = saved;
  }
  expect(cancelled).toEqual([7]);
});

test('the browser clock reads the wall clock', () => {
  const before = Date.now();
  expect(browserScrollbarClock.now()).toBeGreaterThanOrEqual(before);
});
