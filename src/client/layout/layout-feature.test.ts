import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../test-support/fake-context';
import { fakeResizeObserver } from '../test-support/fake-resize-observer';
import { ManualClock } from '../test-support/manual-clock';
import type { GridProposal } from './fitter';
import { applyPaddingColor, installLayout, type LayoutDeps } from './layout-feature';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** The layout installed on fakes; `log` records the fit listeners' updates in order. */
function setup(deps: Partial<LayoutDeps> = {}) {
  fake = fakeContext();
  const canvas = fake.dom.document.createElement('canvas');
  fake.container.append(canvas);
  const log: string[] = [];
  const clock = new ManualClock();
  const observers = fakeResizeObserver();
  let proposal: GridProposal | undefined = { cols: 80, rows: 24 };
  const layout = installLayout(fake.ctx, {
    edges: { update: () => log.push('edges') },
    smoothScroll: { update: () => log.push('smoothScroll') },
    ResizeObserver: observers.ResizeObserver,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    grid: { proposeDimensions: () => proposal },
    ...deps,
  });
  return {
    layout,
    log,
    clock,
    observers: observers.observers,
    propose: (next: GridProposal | undefined) => {
      proposal = next;
    },
  };
}

describe('installLayout', () => {
  test('the first fit is scheduled at install and runs on the next frame', () => {
    const { log, clock } = setup();
    expect(log).toEqual([]);
    expect(clock.pending.frames).toBe(1);
    clock.frame();
    expect(log).toEqual(['edges', 'smoothScroll']);
    expect(fake.term.calls).toEqual(['syncCellPixelSize']);
  });

  test('fit() is synchronous (font zoom) and resizes the terminal', () => {
    const { layout, log, propose } = setup();
    propose({ cols: 90, rows: 30 });
    layout.fit();
    expect(fake.term.calls).toEqual(['resize:90x30', 'syncCellPixelSize']);
    expect(log).toEqual(['edges', 'smoothScroll']);
  });

  test('observes the container border box and refits on a resize, coalesced per frame', () => {
    const { log, clock, observers } = setup();
    clock.frame();
    log.length = 0;
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([
      { target: fake.container, options: { box: 'border-box' } },
    ]);
    observers[0].resize();
    fake.win.dispatch({ type: 'resize' });
    expect(clock.pending.frames).toBe(1);
    clock.frame();
    expect(log).toEqual(['edges', 'smoothScroll']);
  });

  test('adds one window listener, `resize` in the bubble phase', () => {
    setup();
    expect(fake.win.added.map(({ target, type, capture }) => ({ target, type, capture }))).toEqual([
      { target: 'window', type: 'resize', capture: false },
    ]);
  });

  test('once the web fonts load, remeasures the font and refits', async () => {
    const { clock } = setup();
    clock.frame();
    const renderer = fake.term.attachRenderer();
    expect(renderer).toBeDefined();
    fake.term.calls.length = 0;
    await fake.fontsLoaded();
    expect(fake.term.calls).toEqual(['remeasureFont']);
    expect(clock.pending.frames).toBe(1);
  });

  test('a font load before open() only refits', async () => {
    const { clock } = setup();
    clock.frame();
    await fake.fontsLoaded();
    expect(fake.term.calls).toEqual(['syncCellPixelSize']);
    expect(clock.pending.frames).toBe(1);
  });

  test('a device pixel ratio change refits and re-arms for the new ratio', () => {
    const { clock } = setup();
    clock.frame();
    expect(fake.win.queries.map((q) => q.media)).toEqual(['(resolution: 1dppx)']);
    fake.win.devicePixelRatio = 2;
    fake.win.queries[0].dispatch({ type: 'change' });
    expect(clock.pending.frames).toBe(1);
    expect(fake.win.queries.map((q) => q.media)).toEqual([
      '(resolution: 1dppx)',
      '(resolution: 2dppx)',
    ]);
  });

  test('without deps.grid, loads the vendored FitAddon into the terminal', () => {
    setup({ grid: undefined });
    expect(fake.term.calls).toEqual(['loadAddon']);
  });

  test('dispose removes everything it added and stops refitting; twice is a no-op', async () => {
    const { layout, log, clock, observers } = setup();
    layout.dispose();
    expect(clock.pending.frames).toBe(0);
    expect(fake.win.active).toEqual([]);
    expect(fake.win.removed.map((r) => r.type)).toEqual(['resize']);
    expect(observers[0].disconnected).toBe(true);
    expect(fake.win.queries[0].active).toEqual([]);
    fake.win.dispatch({ type: 'resize' });
    fake.term.attachRenderer();
    await fake.fontsLoaded();
    clock.frame();
    expect(log).toEqual([]);
    expect(fake.term.calls).toEqual([]);
    layout.dispose();
  });
});

describe('applyPaddingColor', () => {
  test('colours the container with theme.padding, else theme.background, else nothing', () => {
    fake = fakeContext();
    const { container } = fake;
    applyPaddingColor(container, { ...fake.ctx.config, theme: {} });
    expect(container.style.background).toBe('');
    applyPaddingColor(container, { ...fake.ctx.config, theme: { background: '#102030' } });
    expect(container.style.background).toBe('#102030');
    applyPaddingColor(container, {
      ...fake.ctx.config,
      theme: { background: '#102030', padding: '#405060' },
    });
    expect(container.style.background).toBe('#405060');
  });
});
