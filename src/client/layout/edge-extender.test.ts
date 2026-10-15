import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../test-support/dom-window';
import { ManualClock } from '../test-support/manual-clock';
import { EdgeExtender, type VisibleArea } from './edge-extender';

let dom: DomWindow;
afterEach(() => dom.close());

/** Gives `el` a layout box: happy-dom does no layout, so the test injects the sizes. */
function measure(el: HTMLElement, sizes: Record<string, number>): void {
  for (const [name, value] of Object.entries(sizes)) {
    Object.defineProperty(el, name, { value, configurable: true });
  }
}

/**
 * A container with an 800x400 terminal canvas in a 809x407 box, so both strips show, and
 * an extender over it. happy-dom has no 2D context, so this document's canvases get a
 * recording one; `copies` logs each drawImage as `strip:sx,sy,sw,sh`.
 */
function setup(options: { visibleArea?: () => VisibleArea | undefined; noContext?: boolean } = {}) {
  dom = createDomWindow();
  const { document } = dom;
  const copies: string[] = [];
  const create = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const el = create(tag);
    if (el instanceof dom.window.HTMLCanvasElement && !options.noContext) {
      const ctx = {
        imageSmoothingEnabled: true,
        drawImage: (_src: unknown, sx: number, sy: number, sw: number, sh: number) =>
          copies.push(`${el.dataset.which}:${sx},${sy},${sw},${sh}`),
      };
      el.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
    }
    return el;
  }) as Document['createElement'];
  const container = document.createElement('div');
  document.body.append(container);
  const canvas = create('canvas');
  canvas.width = 1600;
  canvas.height = 800;
  measure(canvas, { offsetLeft: 0, offsetTop: 0, offsetWidth: 800, offsetHeight: 400 });
  container.append(canvas);
  measure(container, { clientWidth: 809, clientHeight: 407 });
  const clock = new ManualClock();
  const win = {
    devicePixelRatio: 2,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
  };
  const edges = new EdgeExtender(container, 0, options.visibleArea, { document, window: win });
  const strips = [...container.querySelectorAll<HTMLCanvasElement>('canvas[data-edge]')];
  if (strips.length === 2) {
    strips[0].dataset.which = 'bottom';
    strips[1].dataset.which = 'right';
  }
  return { container, canvas, edges, strips, clock, win, copies };
}

describe('EdgeExtender', () => {
  test('adds two hidden, marked strips that the canvas lookups skip', () => {
    const { container, canvas, strips } = setup();
    expect(strips).toHaveLength(2);
    for (const strip of strips) {
      expect(strip.style.display).toBe('none');
      expect(strip.style.position).toBe('absolute');
      expect(strip.style.pointerEvents).toBe('none');
    }
    expect(container.querySelector('canvas:not([data-edge])')).toBe(canvas);
  });

  test('update places each strip in the leftover, sized in device pixels', () => {
    const { edges, strips } = setup();
    edges.update();
    const [bottom, right] = strips;
    expect(bottom.style.display).toBe('block');
    expect([bottom.style.left, bottom.style.top, bottom.style.width, bottom.style.height]).toEqual([
      '0px',
      '400px',
      '800px',
      '7px',
    ]);
    expect([bottom.width, bottom.height]).toEqual([1600, 14]);
    expect([right.style.left, right.style.top, right.style.width, right.style.height]).toEqual([
      '800px',
      '0px',
      '9px',
      '400px',
    ]);
    expect([right.width, right.height]).toEqual([18, 800]);
  });

  test('a strip with nothing left over is hidden, and no frame is asked for', () => {
    const { container, edges, strips, clock } = setup();
    measure(container, { clientWidth: 800, clientHeight: 400 });
    edges.update();
    expect(strips.map((s) => s.style.display)).toEqual(['none', 'none']);
    expect(clock.pending.frames).toBe(0);
  });

  test('each frame copies the canvas edge row and column into the strips', () => {
    const { edges, clock, copies } = setup();
    edges.update();
    clock.frame();
    expect(copies).toEqual(['bottom:0,799,1600,1', 'right:1599,0,1,800']);
    // Without a version the canvas may have changed: copied again every frame.
    clock.frame();
    expect(copies).toHaveLength(4);
  });

  test('copies the part in view of the canvas the visible area names', () => {
    let version = 1;
    const { edges, clock, copies, canvas } = setup({
      visibleArea: () => ({ canvas, y: 40, height: 760, lastLine: 790, version }),
    });
    edges.update();
    clock.frame();
    expect(copies).toEqual(['bottom:0,790,1600,1', 'right:1599,40,1,760']);
    // An unchanged version copies nothing but keeps watching.
    clock.frame();
    expect(copies).toHaveLength(2);
    expect(clock.pending.frames).toBe(1);
    version = 2;
    clock.frame();
    expect(copies).toHaveLength(4);
    // A new placement repaints even when the version did not change.
    edges.update();
    clock.frame();
    expect(copies).toHaveLength(6);
  });

  test('nothing to copy from stops the loop', () => {
    const { edges, clock, copies, canvas } = setup();
    edges.update();
    canvas.width = 0;
    clock.frame();
    expect(copies).toEqual([]);
    expect(clock.pending.frames).toBe(0);
  });

  test('update without a terminal canvas does nothing', () => {
    const { edges, canvas, clock, strips } = setup();
    canvas.remove();
    edges.update();
    expect(strips.map((s) => s.style.display)).toEqual(['none', 'none']);
    expect(clock.pending.frames).toBe(0);
  });

  test('without a 2D context there are no strips', () => {
    const { edges, strips, clock } = setup({ noContext: true });
    expect(strips).toHaveLength(0);
    edges.update();
    expect(clock.pending.frames).toBe(0);
  });

  test('dispose removes the strips and cancels the frame; twice is a no-op', () => {
    const { container, edges, clock, copies } = setup();
    edges.update();
    expect(clock.pending.frames).toBe(1);
    edges.dispose();
    expect(container.querySelectorAll('canvas[data-edge]')).toHaveLength(0);
    expect(clock.pending.frames).toBe(0);
    clock.frame();
    edges.update();
    expect(copies).toEqual([]);
    expect(clock.pending.frames).toBe(0);
    edges.dispose();
  });
});
