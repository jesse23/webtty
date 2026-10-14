import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../test-support/dom-window';
import { ManualClock } from '../test-support/manual-clock';
import { Fitter, type FitterHost, type GridProposal } from './fitter';

let dom: DomWindow;
afterEach(() => dom.close());

/** Gives `el` a layout box: happy-dom does no layout, so the test injects the sizes. */
function measure(el: HTMLElement, sizes: Record<string, number>): void {
  for (const [name, value] of Object.entries(sizes)) {
    Object.defineProperty(el, name, { value, configurable: true });
  }
}

/**
 * An 809x407 container holding an 800x400 terminal canvas, a host that logs its calls and
 * a fitter with `padding` over them; `proposal` is what the grid source answers.
 */
function setup(padding = 0) {
  dom = createDomWindow();
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const canvas = dom.document.createElement('canvas');
  measure(canvas, { offsetWidth: 800, offsetHeight: 400 });
  container.append(canvas);
  measure(container, { clientWidth: 809, clientHeight: 407 });
  const calls: string[] = [];
  const host = {
    cols: 80,
    rows: 24,
    resize(cols: number, rows: number) {
      calls.push(`resize:${cols}x${rows}`);
      this.cols = cols;
      this.rows = rows;
    },
    syncCellPixelSize: () => calls.push('syncCellPixelSize'),
  };
  let proposal: GridProposal | undefined = { cols: 80, rows: 24 };
  const clock = new ManualClock();
  const fitter = new Fitter(
    host satisfies FitterHost,
    container,
    padding,
    { proposeDimensions: () => proposal },
    {
      requestAnimationFrame: clock.requestAnimationFrame,
      cancelAnimationFrame: clock.cancelAnimationFrame,
    },
  );
  return {
    container,
    canvas,
    calls,
    clock,
    fitter,
    propose: (next: GridProposal | undefined) => {
      proposal = next;
    },
  };
}

function padding(el: HTMLElement): string[] {
  const { paddingTop, paddingRight, paddingBottom, paddingLeft } = el.style;
  return [paddingTop, paddingRight, paddingBottom, paddingLeft];
}

describe('Fitter', () => {
  test('fit() resizes to the proposed grid and syncs the cell pixels, synchronously', () => {
    const { fitter, calls, propose } = setup();
    propose({ cols: 100, rows: 30 });
    fitter.fit();
    expect(calls).toEqual(['resize:100x30', 'syncCellPixelSize']);
  });

  test('an unchanged grid is not resized, but the cell pixels are still synced', () => {
    const { fitter, calls } = setup();
    fitter.fit();
    expect(calls).toEqual(['syncCellPixelSize']);
  });

  test('no proposal (the font is not measured yet) only resets the padding', () => {
    const { fitter, calls, container, propose } = setup(6);
    propose(undefined);
    let hooks = 0;
    fitter.onFitted(() => hooks++);
    fitter.fit();
    expect(container.style.padding).toBe('6px');
    expect(calls).toEqual([]);
    expect(hooks).toBe(0);
  });

  test('places the padding: top and left exact, the leftover to the right and bottom', () => {
    const { fitter, container } = setup(0);
    fitter.fit();
    expect(padding(container)).toEqual(['0px', '9px', '7px', '0px']);
  });

  test('the leftover includes the configured padding on both sides', () => {
    const { fitter, container } = setup(2);
    fitter.fit();
    expect(padding(container)).toEqual(['2px', '7px', '5px', '2px']);
  });

  test('without a terminal canvas the padding stays uniform and no hook runs', () => {
    const { fitter, container, canvas } = setup(3);
    canvas.dataset.edge = 'true';
    let hooks = 0;
    fitter.onFitted(() => hooks++);
    fitter.fit();
    expect(padding(container)).toEqual(['3px', '3px', '3px', '3px']);
    expect(hooks).toBe(0);
  });

  test('hooks run after the padding is placed, in the order added', () => {
    const { fitter, container } = setup();
    const log: string[] = [];
    fitter.onFitted(() => log.push(`edges ${container.style.paddingRight}`));
    fitter.onFitted(() => log.push('smoothScroll'));
    fitter.fit();
    expect(log).toEqual(['edges 9px', 'smoothScroll']);
  });

  test('a removed hook no longer runs; removing it twice is harmless', () => {
    const { fitter } = setup();
    let runs = 0;
    const hook = fitter.onFitted(() => runs++);
    hook.dispose();
    hook.dispose();
    fitter.fit();
    expect(runs).toBe(0);
  });

  test('schedule() coalesces the signals of one frame into one fit', () => {
    const { fitter, calls, clock } = setup();
    fitter.schedule();
    fitter.schedule();
    fitter.schedule();
    expect(calls).toEqual([]);
    expect(clock.pending.frames).toBe(1);
    clock.frame();
    expect(calls).toEqual(['syncCellPixelSize']);
    fitter.schedule();
    clock.frame();
    expect(calls).toEqual(['syncCellPixelSize', 'syncCellPixelSize']);
  });

  test('dispose cancels a scheduled fit and stops scheduling; twice is a no-op', () => {
    const { fitter, calls, clock } = setup();
    let hooks = 0;
    fitter.onFitted(() => hooks++);
    fitter.schedule();
    fitter.dispose();
    expect(clock.pending.frames).toBe(0);
    fitter.schedule();
    expect(clock.pending.frames).toBe(0);
    fitter.dispose();
    fitter.fit();
    expect(calls).toEqual(['syncCellPixelSize']);
    expect(hooks).toBe(0);
  });
});
