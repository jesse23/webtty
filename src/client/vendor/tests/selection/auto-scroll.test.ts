import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import {
  AUTO_SCROLL_EDGE_PX,
  AUTO_SCROLL_INTERVAL_MS,
  AutoScroll,
  edgeDirection,
  extendedEnd,
  type ScrollDirection,
} from '../../ghostty-web/selection/auto-scroll';

// The drag auto-scroll on a manual clock: its edge, its interval, restarts and teardown.

/** An AutoScroll on a manual clock, recording each step's direction. */
function scroller() {
  const clock = new ManualClock();
  const steps: ScrollDirection[] = [];
  const scroll = new AutoScroll((direction) => steps.push(direction), clock);
  return { clock, steps, scroll };
}

describe('edgeDirection', () => {
  test.each([
    [0, -1],
    [AUTO_SCROLL_EDGE_PX - 1, -1],
    [AUTO_SCROLL_EDGE_PX, 0],
    [100 - AUTO_SCROLL_EDGE_PX, 0],
    [100 - AUTO_SCROLL_EDGE_PX + 1, 1],
  ])('a drag at y %p of a 100 px canvas scrolls %p', (y, direction) => {
    expect(edgeDirection(y, 100)).toBe(direction as ScrollDirection | 0);
  });
});

describe('extendedEnd', () => {
  const view = { top: 10, bottom: 13, lastCol: 79 };

  test.each([
    // Up: to the top-left visible cell, only when that is above the end
    [{ col: 5, absoluteRow: 12 }, -1, { col: 0, absoluteRow: 10 }],
    [{ col: 5, absoluteRow: 10 }, -1, null],
    // Down: to the bottom-right visible cell, only when that is below the end
    [{ col: 5, absoluteRow: 11 }, 1, { col: 79, absoluteRow: 13 }],
    [{ col: 5, absoluteRow: 13 }, 1, null],
  ])('the end %j scrolling %p moves to %j', (end, direction, moved) => {
    expect(extendedEnd(end, direction as ScrollDirection, view)).toEqual(moved);
  });
});

describe('AutoScroll', () => {
  test('steps every interval in its direction until stopped', () => {
    const { clock, steps, scroll } = scroller();
    scroll.start(1);
    expect(scroll.direction).toBe(1);
    clock.advance(AUTO_SCROLL_INTERVAL_MS * 3);
    expect(steps).toEqual([1, 1, 1]);
    scroll.stop();
    expect(scroll.direction).toBe(0);
    clock.advance(AUTO_SCROLL_INTERVAL_MS * 3);
    expect(steps).toEqual([1, 1, 1]);
    expect(clock.pending.timers).toBe(0);
  });

  test('starting in the same direction keeps the interval; another restarts it', () => {
    const { clock, steps, scroll } = scroller();
    scroll.start(-1);
    clock.advance(30);
    scroll.start(-1);
    clock.advance(20);
    expect(steps).toEqual([-1]);
    scroll.start(1);
    clock.advance(30);
    expect(steps).toEqual([-1]);
    clock.advance(20);
    expect(steps).toEqual([-1, 1]);
    expect(clock.pending.timers).toBe(1);
  });

  test('followEdge scrolls near an edge and stops in the middle', () => {
    const { scroll } = scroller();
    scroll.followEdge(5, 200);
    expect(scroll.direction).toBe(-1);
    scroll.followEdge(195, 200);
    expect(scroll.direction).toBe(1);
    scroll.followEdge(100, 200);
    expect(scroll.direction).toBe(0);
  });

  test('dispose stops the interval, and a second dispose does nothing', () => {
    const { clock, steps, scroll } = scroller();
    scroll.start(1);
    scroll.dispose();
    expect(clock.pending.timers).toBe(0);
    scroll.dispose();
    clock.advance(AUTO_SCROLL_INTERVAL_MS * 2);
    expect(steps).toEqual([]);
  });

  test('runs on the global timers by default', async () => {
    const steps: ScrollDirection[] = [];
    const scroll = new AutoScroll((direction) => steps.push(direction));
    scroll.start(-1);
    await Bun.sleep(AUTO_SCROLL_INTERVAL_MS + 20);
    scroll.dispose();
    expect(steps[0]).toBe(-1);
  });
});
