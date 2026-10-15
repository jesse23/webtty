import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { ManualClock } from '../../../test-support/manual-clock';
import type { KittyTerminal } from './kitty-terminal';
import { OverlayCanvas } from './overlay-canvas';
import { placementAt } from './placement-geometry';
import { Placements } from './placements';
import { fakeBitmap } from './test-support/graphics-harness';

let dom: DomWindow;
afterEach(() => dom.close());

/**
 * An overlay in a happy-dom container beside an 800x600 terminal canvas, over 10x20 px
 * cells, with its frames stepped by a manual clock and its drawing recorded.
 */
function setup(withTerminalCanvas = true) {
  dom = createDomWindow();
  const { document } = dom;
  const container = document.createElement('div');
  document.body.append(container);
  if (withTerminalCanvas) {
    const canvas = document.createElement('canvas');
    for (const [key, value] of Object.entries({
      offsetLeft: 3,
      offsetTop: 4,
      offsetWidth: 800,
      offsetHeight: 600,
    })) {
      Object.defineProperty(canvas, key, { value });
    }
    container.append(canvas);
  }
  const sync = { held: false, at: [] as number[] };
  const term = {
    write: () => {},
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    viewportY: 0,
    renderer: { getMetrics: () => ({ width: 10, height: 20 }), scrollOffset: 0 },
    renderHeld: (now: number) => {
      sync.at.push(now);
      return sync.held;
    },
  } satisfies KittyTerminal;
  const placements = new Placements();
  const bitmaps = new Map<number, ImageBitmap>();
  const clock = new ManualClock();
  const win = {
    devicePixelRatio: 2,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
  };
  let visibility: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', { get: () => visibility });
  const removed: string[] = [];
  const remove = document.removeEventListener.bind(document);
  Object.defineProperty(document, 'removeEventListener', {
    value: (...args: Parameters<Document['removeEventListener']>) => {
      removed.push(args[0]);
      remove(...args);
    },
  });
  const source = { placements, images: { bitmapOf: (id: number) => bitmaps.get(id) } };
  const overlay = new OverlayCanvas(term, container, source, { document, window: win });
  const canvas = container.querySelector('canvas[data-kitty]') as HTMLCanvasElement;
  const draws: number[][] = [];
  let repaints = 0;
  const ctx = {
    setTransform() {},
    clearRect: () => repaints++,
    drawImage: (_img: unknown, ...rect: number[]) => draws.push(rect),
  };
  let context: object | null = ctx;
  Object.defineProperty(canvas, 'getContext', { value: () => context });
  const place = (imageId: number, col = 0, absRow = 0) =>
    placements.add(placementAt({}, imageId, { absRow, col }, { x: 2, y: 2 }));
  return {
    term,
    sync,
    container,
    placements,
    bitmaps,
    clock,
    win,
    overlay,
    canvas,
    draws,
    removed,
    place,
    repaints: () => repaints,
    setVisibility: (v: DocumentVisibilityState) => {
      visibility = v;
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
    noContext: () => {
      context = null;
    },
  };
}

describe('OverlayCanvas', () => {
  test('is an empty, click-through canvas appended to the container, with one frame queued', () => {
    const s = setup();
    expect(s.canvas.parentElement).toBe(s.container);
    expect([s.canvas.width, s.canvas.height]).toEqual([0, 0]);
    expect(s.canvas.style.position).toBe('absolute');
    expect(s.canvas.style.pointerEvents).toBe('none');
    expect(s.clock.pending.frames).toBe(1);
  });

  test("draws placed bitmaps at device resolution over the terminal's canvas", () => {
    const s = setup();
    s.bitmaps.set(1, fakeBitmap(40, 20));
    s.place(1, 2);
    s.overlay.markDirty();
    s.clock.frame();
    expect([s.canvas.width, s.canvas.height]).toEqual([1600, 1200]);
    const st = s.canvas.style;
    expect([st.left, st.top, st.width, st.height]).toEqual(['3px', '4px', '800px', '600px']);
    expect(s.draws).toEqual([[0, 0, 40, 20, 20, 0, 20, 10]]);
  });

  test('skips placements without a bitmap and ones off screen', () => {
    const s = setup();
    s.bitmaps.set(1, fakeBitmap(40, 20));
    s.place(2);
    s.place(1, 200);
    s.place(1, 0, 100);
    s.clock.frame();
    expect(s.repaints()).toBe(1);
    expect(s.draws).toEqual([]);
  });

  test('repaints only when marked dirty, invalidated or the geometry changes', () => {
    const s = setup();
    s.bitmaps.set(1, fakeBitmap(4, 4));
    s.place(1);
    s.clock.frame();
    s.clock.frame();
    expect(s.repaints()).toBe(1);
    s.overlay.markDirty();
    s.clock.frame();
    s.overlay.invalidate();
    s.clock.frame();
    expect(s.repaints()).toBe(3);
    s.win.devicePixelRatio = 1;
    s.clock.frame();
    expect(s.repaints()).toBe(4);
    expect(s.canvas.width).toBe(800);
  });

  test("holds its repaints while the app's synchronized update runs, then catches up (ADR 067)", () => {
    const s = setup();
    s.bitmaps.set(1, fakeBitmap(4, 4));
    s.place(1);
    s.sync.held = true;
    s.clock.frame();
    s.overlay.markDirty();
    s.clock.frame();
    expect(s.repaints()).toBe(0);
    // Each frame asks with its own timestamp.
    expect(s.sync.at).toHaveLength(2);
    expect(s.sync.at[1]).toBeGreaterThan(s.sync.at[0]);
    s.sync.held = false;
    s.clock.frame();
    expect([s.repaints(), s.draws.length]).toEqual([1, 1]);
  });

  test('a tab coming back to the foreground repaints; hiding it does not', () => {
    const s = setup();
    s.place(1);
    s.clock.frame();
    s.setVisibility('hidden');
    s.clock.frame();
    expect(s.repaints()).toBe(1);
    s.setVisibility('visible');
    s.clock.frame();
    expect(s.repaints()).toBe(2);
  });

  test('frees its backing store when the last placement goes', () => {
    const s = setup();
    s.place(1);
    s.clock.frame();
    expect(s.canvas.width).toBe(1600);
    s.placements.clear();
    s.overlay.markDirty();
    s.clock.frame();
    expect([s.canvas.width, s.canvas.height]).toEqual([0, 0]);
  });

  test('waits for the terminal canvas and for a 2D context', () => {
    const none = setup(false);
    none.place(1);
    none.clock.frame();
    expect(none.canvas.width).toBe(0);
    dom.close();
    const s = setup();
    s.noContext();
    s.place(1);
    s.clock.frame();
    expect(s.canvas.width).toBe(1600);
    expect(s.repaints()).toBe(0);
  });

  test('dispose cancels the frame, removes the listener and the canvas; twice is a no-op', () => {
    const s = setup();
    s.overlay.dispose();
    expect(s.clock.pending.frames).toBe(0);
    expect(s.removed).toEqual(['visibilitychange']);
    expect(s.canvas.isConnected).toBe(false);
    s.overlay.dispose();
    expect(s.removed).toEqual(['visibilitychange']);
    expect(s.clock.pending.frames).toBe(0);
  });
});
