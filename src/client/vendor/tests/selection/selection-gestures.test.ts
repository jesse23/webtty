import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import { RecordingTarget } from '../../../test-support/recording-target';
import type { ScreenRange } from '../../ghostty-web/engine/engine-types';
import { AUTO_SCROLL_INTERVAL_MS } from '../../ghostty-web/selection/auto-scroll';
import type { BufferPoint } from '../../ghostty-web/selection/selection-coords';
import {
  type GestureHost,
  SelectionGestures,
} from '../../ghostty-web/selection/selection-gestures';
import { CELL, FakeCanvas, fire } from '../support/selection-fixture';

// The gestures on a fake host: drags inside and outside the canvas, the auto-scroll that
// extends a drag, multi-clicks, outside clicks and teardown. Rows are absolute; the host
// maps pixel row r to absolute row r + top.

/** A 10x4 grid at client (100, 50), whose host keeps the selection and logs every call. */
function gestures(options: { appTakes?: boolean; range?: ScreenRange | null } = {}) {
  const canvas = new FakeCanvas({ left: 100, top: 50, right: 180, bottom: 114 });
  const doc = new RecordingTarget('document');
  const clock = new ManualClock();
  const log: string[] = [];
  const view = { top: 20, bottom: 23, lastCol: 9 };
  let start: BufferPoint | null = null;
  let end: BufferPoint | null = null;
  let made = 0;
  const g: SelectionGestures = new SelectionGestures(
    canvas as unknown as HTMLCanvasElement,
    doc as unknown as Document,
    {
      pointAt: (x, y) => ({
        col: Math.min(9, Math.floor(x / CELL.width)),
        absoluteRow: view.top + Math.min(3, Math.floor(y / CELL.height)),
      }),
      cellWidth: () => CELL.width,
      appTakesPress: () => options.appTakes ?? false,
      clickRange: (clicks, at) => {
        log.push(`clickRange ${clicks} ${at.col},${at.absoluteRow}`);
        return options.range === undefined ? null : options.range;
      },
      scrollLines: (amount) => {
        log.push(`scroll ${amount}`);
        view.top += amount;
        view.bottom += amount;
      },
      visibleRows: () => ({ ...view }),
      hasSelection: () => start !== null && !g.pressPending,
      clearSelection: () => {
        log.push('clear');
        start = end = null;
        g.endDrag();
      },
      select: (s, e) => {
        start = s;
        end = e;
      },
      selectionEnd: () => end,
      extendTo: (e) => {
        end = e;
      },
      selectionMade: () => void made++,
    } satisfies GestureHost,
    clock,
  );
  return {
    g,
    canvas,
    doc,
    clock,
    log,
    selection: () => (start && end ? [start, end] : null),
    made: () => made,
    /** Forgets the selection without ending the drag. */
    drop: () => {
      start = end = null;
    },
  };
}

type Gestures = ReturnType<typeof gestures>;

/** A press at cell (col, row) of the canvas. */
const press = (t: Gestures, col: number, row: number, init: object = {}) =>
  fire(t.canvas, 'mousedown', { button: 0, offsetX: col * 8 + 1, offsetY: row * 16 + 4, ...init });

/** A move over the document at a client position. */
const moveTo = (t: Gestures, clientX: number, clientY: number) =>
  fire(t.doc, 'mousemove', { clientX, clientY });

describe('SelectionGestures press and drag', () => {
  test('a left press focuses the container and anchors a pending selection', () => {
    const t = gestures();
    press(t, 2, 1);
    expect(t.canvas.parentElement.focused).toBe(1);
    expect(t.g.pressPending).toBe(true);
    expect(t.selection()).toEqual([
      { col: 2, absoluteRow: 21 },
      { col: 2, absoluteRow: 21 },
    ]);
  });

  test('a right press does nothing; a press the app takes focuses but selects nothing', () => {
    const right = gestures();
    press(right, 2, 1, { button: 2 });
    expect(right.canvas.parentElement.focused).toBe(0);
    expect(right.selection()).toBeNull();
    const app = gestures({ appTakes: true });
    press(app, 2, 1);
    expect(app.canvas.parentElement.focused).toBe(1);
    expect(app.selection()).toBeNull();
  });

  test('a new press clears the selection there was', () => {
    const t = gestures();
    press(t, 0, 0);
    fire(t.canvas, 'mousemove', { offsetX: 40, offsetY: 4 });
    fire(t.doc, 'mouseup');
    press(t, 3, 2);
    expect(t.log).toEqual(['clear']);
  });

  test('a canvas move under half a cell is ignored; past it the end follows', () => {
    const t = gestures();
    press(t, 0, 0);
    fire(t.canvas, 'mousemove', { offsetX: 4, offsetY: 4 });
    expect(t.g.pressPending).toBe(true);
    fire(t.canvas, 'mousemove', { offsetX: 33, offsetY: 36 });
    expect(t.g.pressPending).toBe(false);
    expect(t.selection()?.[1]).toEqual({ col: 4, absoluteRow: 22 });
    // Once a drag, small moves count
    fire(t.canvas, 'mousemove', { offsetX: 34, offsetY: 4 });
    expect(t.selection()?.[1]).toEqual({ col: 4, absoluteRow: 20 });
  });

  test('a canvas move with no press does nothing', () => {
    const t = gestures();
    fire(t.canvas, 'mousemove', { offsetX: 40, offsetY: 40 });
    moveTo(t, 0, 0);
    fire(t.doc, 'mouseup');
    expect(t.selection()).toBeNull();
    expect(t.clock.pending.timers).toBe(0);
  });

  test('a release after a drag reports the selection; a click without a drag clears it', () => {
    const dragged = gestures();
    press(dragged, 0, 0);
    fire(dragged.canvas, 'mousemove', { offsetX: 40, offsetY: 4 });
    fire(dragged.doc, 'mouseup');
    expect(dragged.made()).toBe(1);
    const clicked = gestures();
    press(clicked, 0, 0);
    fire(clicked.doc, 'mouseup');
    expect(clicked.log).toEqual(['clear']);
    expect(clicked.made()).toBe(0);
  });

  test('a drag near the bottom edge scrolls and extends to the last visible cell', () => {
    const t = gestures();
    press(t, 0, 0);
    fire(t.canvas, 'mousemove', { offsetX: 40, offsetY: 60 });
    t.clock.advance(AUTO_SCROLL_INTERVAL_MS);
    expect(t.log).toEqual(['scroll 3']);
    expect(t.selection()?.[1]).toEqual({ col: 9, absoluteRow: 26 });
    // Back in the middle the scrolling stops
    fire(t.canvas, 'mousemove', { offsetX: 40, offsetY: 32 });
    expect(t.clock.pending.timers).toBe(0);
  });
});

describe('SelectionGestures outside the canvas', () => {
  test('a drag above the canvas scrolls up and extends to the top-left visible cell', () => {
    const t = gestures();
    press(t, 5, 2);
    moveTo(t, 140, 10);
    t.clock.advance(AUTO_SCROLL_INTERVAL_MS * 2);
    expect(t.log).toEqual(['scroll -3', 'scroll -3']);
    expect(t.selection()?.[1]).toEqual({ col: 0, absoluteRow: 14 });
  });

  test('a drag beside the canvas follows the pointer clamped to its edge, without scrolling', () => {
    const t = gestures();
    press(t, 5, 2);
    moveTo(t, 400, 70);
    expect(t.clock.pending.timers).toBe(0);
    expect(t.selection()?.[1]).toEqual({ col: 9, absoluteRow: 21 });
    moveTo(t, 0, 70);
    expect(t.selection()?.[1]).toEqual({ col: 0, absoluteRow: 21 });
  });

  test('a document move inside the canvas or under the threshold changes nothing', () => {
    const t = gestures();
    press(t, 5, 2);
    // Over the press point (client 141, 86): under the threshold
    moveTo(t, 142, 86);
    expect(t.g.pressPending).toBe(true);
    // Inside the canvas: the canvas's own mousemove handles it
    moveTo(t, 170, 100);
    expect(t.g.pressPending).toBe(false);
    expect(t.selection()?.[1]).toEqual({ col: 5, absoluteRow: 22 });
  });

  test('leaving the canvas mid-drag scrolls toward that side; entering it stops', () => {
    const t = gestures();
    fire(t.canvas, 'mouseleave', { clientY: 0 });
    expect(t.clock.pending.timers).toBe(0);
    press(t, 5, 2);
    fire(t.canvas, 'mouseleave', { clientY: 80 });
    expect(t.clock.pending.timers).toBe(0);
    fire(t.canvas, 'mouseleave', { clientY: 200 });
    t.clock.advance(AUTO_SCROLL_INTERVAL_MS);
    expect(t.log).toEqual(['scroll 3']);
    fire(t.canvas, 'mouseenter');
    expect(t.clock.pending.timers).toBe(0);
    fire(t.canvas, 'mouseleave', { clientY: 0 });
    fire(t.doc, 'mouseup');
    expect(t.clock.pending.timers).toBe(0);
  });

  test('a scroll step after the drag ended stops the auto-scroll', () => {
    const t = gestures();
    press(t, 5, 2);
    moveTo(t, 140, 200);
    t.g.endDrag();
    t.clock.advance(AUTO_SCROLL_INTERVAL_MS);
    expect(t.log).toEqual([]);
    expect(t.clock.pending.timers).toBe(0);
  });

  test('a scroll step with no selection only scrolls', () => {
    const t = gestures();
    press(t, 5, 2);
    moveTo(t, 140, 200);
    // The host lost its selection while the drag goes on
    t.drop();
    t.clock.advance(AUTO_SCROLL_INTERVAL_MS);
    expect(t.log).toEqual(['scroll 3']);
    expect(t.selection()).toBeNull();
  });
});

describe('SelectionGestures clicks', () => {
  const word: ScreenRange = { start: { col: 1, row: 20 }, end: { col: 4, row: 20 } };

  test('a double click selects the range the host gives and reports it', () => {
    const t = gestures({ range: word });
    fire(t.canvas, 'click', { detail: 2, offsetX: 17, offsetY: 4 });
    expect(t.log).toEqual(['clickRange 2 2,20']);
    expect(t.selection()).toEqual([
      { col: 1, absoluteRow: 20 },
      { col: 4, absoluteRow: 20 },
    ]);
    expect(t.made()).toBe(1);
  });

  test('a single click, a click the app takes, or no range selects nothing', () => {
    const single = gestures({ range: word });
    fire(single.canvas, 'click', { detail: 1, offsetX: 17, offsetY: 4 });
    const app = gestures({ range: word, appTakes: true });
    fire(app.canvas, 'click', { detail: 3, offsetX: 17, offsetY: 4 });
    const none = gestures({ range: null });
    fire(none.canvas, 'click', { detail: 3, offsetX: 17, offsetY: 4 });
    expect([single, app, none].map((t) => t.made())).toEqual([0, 0, 0]);
    expect(none.log).toEqual(['clickRange 3 2,20']);
  });

  test('a click outside the canvas clears the selection', () => {
    const t = gestures({ range: word });
    fire(t.canvas, 'click', { detail: 2, offsetX: 17, offsetY: 4 });
    const elsewhere = {};
    fire(t.doc, 'mousedown', { target: elsewhere });
    fire(t.doc, 'click', { target: elsewhere });
    expect(t.selection()).toBeNull();
  });

  test('a click inside the canvas, or ending a drag begun inside, keeps the selection', () => {
    const t = gestures({ range: word });
    fire(t.canvas, 'click', { detail: 2, offsetX: 17, offsetY: 4 });
    fire(t.doc, 'mousedown', { target: t.canvas });
    fire(t.doc, 'click', { target: {} });
    const inner = {};
    t.canvas.inside.add(inner);
    fire(t.doc, 'mousedown', { target: {} });
    fire(t.doc, 'click', { target: inner });
    expect(t.log).not.toContain('clear');
  });

  test('an outside click during a drag, or with nothing selected, clears nothing', () => {
    const t = gestures();
    press(t, 0, 0);
    fire(t.doc, 'click', { target: {} });
    expect(t.log).toEqual([]);
    fire(t.doc, 'mouseup');
    t.log.length = 0;
    fire(t.doc, 'click', { target: {} });
    expect(t.log).toEqual([]);
  });
});

describe('SelectionGestures dispose', () => {
  test('removes every canvas and document listener and stops scrolling, once (ADR 065)', () => {
    const t = gestures();
    expect(t.doc.added.map((r) => r.type)).toEqual(['mousemove', 'mousedown', 'mouseup', 'click']);
    press(t, 0, 0);
    moveTo(t, 140, 200);
    t.g.dispose();
    expect(t.clock.pending.timers).toBe(0);
    for (const target of [t.doc, t.canvas]) {
      expect(target.active).toEqual([]);
      // The store removes them newest first
      expect([...target.removed].reverse()).toEqual(target.added);
    }
    t.g.dispose();
    expect(t.doc.removed.length + t.canvas.removed.length).toBe(9);
  });
});
