import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import { CanvasRenderer } from '../../ghostty-web/renderer';
import { rasterCanvas } from '../support/raster-canvas';
import {
  COLS,
  previousFrame,
  ROWS,
  rasterRenderer,
  writtenTerminal,
} from '../support/renderer-harness';

// The facade: options and deps, the frame's stale and resize triggers, the getters and
// teardown. What it paints is tested with the painters in render/.

/** A fake window whose ratio can change, with the media query listener the watch arms. */
function ratioWindow(ratio: number) {
  const listeners = new Set<() => void>();
  const win = {
    devicePixelRatio: ratio,
    matchMedia: () => ({
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }),
  };
  const change = (next: number) => {
    win.devicePixelRatio = next;
    for (const listener of [...listeners]) {
      listeners.delete(listener);
      listener();
    }
  };
  return { win: win as unknown as Window, change, listeners };
}

/** A document that makes raster canvases, the first being the one the renderer draws on. */
function rasterDocument() {
  const created: ReturnType<typeof rasterCanvas>[] = [];
  const document = {
    createElement: () => {
      const canvas = rasterCanvas();
      created.push(canvas);
      return canvas.canvas;
    },
  } as unknown as Document;
  return { document, created };
}

describe('CanvasRenderer', () => {
  test('visibleArea.version moves when the canvas is drawn on and not on an idle frame', async () => {
    const t = await writtenTerminal();
    const live = rasterRenderer(2);
    live.r.render(t.term, true, 0, t.provider, 0);
    live.r.render(t.term, false, 0, t.provider, 0);
    const idle = live.r.visibleArea.version;
    // Nothing changed: the edge strips may skip their copy.
    live.r.render(t.term, false, 0, t.provider, 0);
    expect(live.r.visibleArea.version).toBe(idle);
    // Output, and a scroll, draw on the canvas.
    t.term.write('more output\r\n');
    live.r.render(t.term, false, 0, t.provider, 0);
    const afterOutput = live.r.visibleArea.version;
    expect(afterOutput).toBeGreaterThan(idle);
    live.r.render(t.term, false, 3, t.provider, 0);
    expect(live.r.visibleArea.version).toBeGreaterThan(afterOutput);
    t.term.free();
  });

  test(`an offset set for a taller cell shows at most a line`, async () => {
    const t = await writtenTerminal();
    const live = rasterRenderer(2);
    const h = live.r.getMetrics().height;
    live.r.setScrollOffset(h + 6);
    live.r.render(t.term, true, 3, t.provider, 0);
    expect(live.r.scrollOffset).toBe(h - 0.5);
    expect(live.shown()).toEqual(previousFrame(t, 3, h - 0.5, 2));
    t.term.free();
  });

  test.each([
    ['setFontSize', (r: CanvasRenderer) => r.setFontSize(20), '20px monospace'],
    ['setFontFamily', (r: CanvasRenderer) => r.setFontFamily('serif'), '15px serif'],
    ['remeasureFont', (r: CanvasRenderer) => r.remeasureFont(), '15px monospace'],
  ])('%s marks every row stale for the next frame', async (_name, change, font) => {
    const { term, provider } = await writtenTerminal();
    const live = rasterRenderer(1);
    live.r.render(term, true, 0, provider, 0);
    const before = live.drawn.length;
    live.r.render(term, false, 0, provider, 0);
    expect(live.drawn.length).toBe(before);
    change(live.r);
    live.r.render(term, false, 0, provider, 0);
    expect(live.drawn.length - before).toBe(ROWS);
    expect(live.shown().some((p) => p.includes(` ${font} `))).toBe(true);
    term.free();
  });

  test('clear blanks the canvas and the next frame repaints every row', async () => {
    const { term, provider } = await writtenTerminal();
    const live = rasterRenderer(1);
    live.r.render(term, true, 0, provider, 0);
    const shown = live.shown();
    const version = live.r.visibleArea.version;
    live.r.clear();
    expect(live.r.visibleArea.version).toBeGreaterThan(version);
    expect(new Set(live.shown())).toEqual(new Set(['#1e1e1e']));
    live.r.render(term, false, 0, provider, 0);
    expect(live.shown()).toEqual(shown);
    term.free();
  });

  test('a scrolled frame without scrollback rows repaints every row on the next frame', async () => {
    const { term } = await writtenTerminal();
    const live = rasterRenderer(1);
    live.r.render(term, true, 0, undefined, 0);
    live.r.render(term, false, 2, undefined, 0);
    const before = live.drawn.length;
    live.r.render(term, false, 2, undefined, 0);
    expect(live.drawn.length).toBeGreaterThan(before);
    term.free();
  });

  test('a buffer that asks for a full redraw gets one', async () => {
    const { term, provider } = await writtenTerminal();
    const live = rasterRenderer(1);
    live.r.render(term, true, 0, provider, 0);
    const before = live.drawn.length;
    const full = new Proxy(term, {
      get: (t, k) => {
        if (k === 'needsFullRedraw') return () => true;
        const v = t[k as keyof typeof t];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    live.r.render(full, false, 0, provider, 0);
    expect(live.drawn.length - before).toBe(ROWS);
    term.free();
  });

  test(`a restored context is repainted on the next frame`, async () => {
    const { term, provider } = await writtenTerminal();
    for (const y of [6, 0]) {
      const live = rasterRenderer(2);
      live.r.render(term, true, 0, provider, 1);
      live.r.render(term, false, y, provider, 1);
      live.lose();
      live.r.render(term, false, y, provider, 1);
      const full = rasterRenderer(2);
      full.r.render(term, true, y, provider, 1);
      expect(live.shown()).toEqual(full.shown());
      // Disposed, it no longer listens
      live.r.dispose();
      live.lose();
      live.r.render(term, false, y, provider, 1);
      expect(live.shown()).not.toEqual(full.shown());
    }
    term.free();
  });

  test('sizes the element and the drawing canvas with its overscan rows', () => {
    const { document, created } = rasterDocument();
    const element = { style: {} } as HTMLCanvasElement;
    const r = new CanvasRenderer(element, { devicePixelRatio: 2, overscan: 3 }, { document });
    r.resize(COLS, ROWS);
    expect(r.getCanvas()).toBe(element);
    expect([r.charWidth, r.charHeight]).toEqual([8, 15]);
    expect(r.getMetrics()).toEqual({ width: 8, height: 15, baseline: 11 });
    expect(element.style.width).toBe(`${COLS * 8}px`);
    expect(element.style.height).toBe(`${ROWS * 15}px`);
    expect([element.width, element.height]).toEqual([0, 0]);
    const canvas = created[0].canvas;
    expect(canvas.style.height).toBe(`${(ROWS + 6) * 15}px`);
    expect([canvas.width, canvas.height]).toEqual([COLS * 8 * 2, (ROWS + 6) * 15 * 2]);
    expect(r.visibleArea.canvas).toBe(canvas);
  });

  test('follows the window ratio, rounded up, until disposed', async () => {
    const { term, provider } = await writtenTerminal();
    const { document, created } = rasterDocument();
    const { win, change, listeners } = ratioWindow(1.5);
    const r = new CanvasRenderer({ style: {} } as HTMLCanvasElement, {}, { document, window: win });
    expect(r.devicePixelRatio).toBe(2);
    r.render(term, true, 0, provider, 0);
    expect(created[0].canvas.width).toBe(COLS * 8 * 2);
    change(3);
    expect(r.devicePixelRatio).toBe(3);
    r.render(term, false, 0, provider, 0);
    expect(created[0].canvas.width).toBe(COLS * 8 * 3);
    expect(listeners.size).toBe(1);
    r.dispose();
    expect(listeners.size).toBe(0);
    term.free();
  });

  test('dispose stops the blink, removes the drawing canvas and frees the scratch, once', () => {
    const clock = new ManualClock();
    const { document, created } = rasterDocument();
    let removed = 0;
    const r = new CanvasRenderer(
      { style: {} } as HTMLCanvasElement,
      { devicePixelRatio: 1, cursorBlink: true },
      { document, timers: clock },
    );
    Object.assign(created[0].canvas, { remove: () => removed++ });
    expect(clock.pending.timers).toBe(1);
    created[1].canvas.height = 30;
    r.dispose();
    expect(clock.pending.timers).toBe(0);
    expect(removed).toBe(1);
    expect(created[1].canvas.height).toBe(0);
    r.dispose();
    expect(clock.pending.timers).toBe(0);
  });

  test('a canvas without a 2D context throws', () => {
    const document = { createElement: () => ({ style: {}, dataset: {}, getContext: () => null }) };
    expect(
      () =>
        new CanvasRenderer(
          {} as HTMLCanvasElement,
          { devicePixelRatio: 1 },
          {
            document: document as unknown as Document,
          },
        ),
    ).toThrow('2D rendering context');
  });
});
