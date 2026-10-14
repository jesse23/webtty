import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../test-support/dom-window';
import { ManualClock } from '../../test-support/manual-clock';
import { Composer, type ComposerTerminal } from './composer';

let dom: DomWindow;
afterEach(() => dom.close());

/**
 * A composer on an injected happy-dom container holding an 800 px wide terminal canvas,
 * over a terminal whose cursor cell the test moves.
 */
function setup(theme: { foreground?: string; background?: string } = {}) {
  dom = createDomWindow();
  const { document, window } = dom;
  const container = document.createElement('div');
  document.body.append(container);
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'offsetLeft', { value: 4 });
  Object.defineProperty(canvas, 'offsetWidth', { value: 800 });
  container.append(canvas);
  const cursor = { spot: { left: 94, top: 40 } as { left: number; top: number } | undefined };
  const term: ComposerTerminal = {
    getCursorCellOffset: () => cursor.spot,
    options: { fontFamily: 'Menlo', fontSize: 14 },
    renderer: { getMetrics: () => ({ width: 9, height: 20 }) },
  };
  const clock = new ManualClock();
  const composer = new Composer(term, container, theme, {
    document,
    window: {
      requestAnimationFrame: clock.requestAnimationFrame,
      cancelAnimationFrame: clock.cancelAnimationFrame,
    },
  });
  const overlay = container.querySelector('[data-compose]') as HTMLElement;
  // happy-dom has no CompositionEvent of its own (its constructor is Event's), so the
  // event carries its data as a plain field.
  const fire = (type: string, data?: string) =>
    container.dispatchEvent(
      type === 'focusout'
        ? new window.FocusEvent('focusout')
        : Object.assign(new window.Event(type), { data }),
    );
  return { container, cursor, term, clock, composer, overlay, fire };
}

describe('Composer', () => {
  test('adds a hidden overlay to the container', () => {
    const { overlay } = setup();
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.position).toBe('absolute');
    expect(overlay.style.pointerEvents).toBe('none');
  });

  test('shows the composition over the cursor cell, in the font and theme colours', () => {
    const { overlay, fire } = setup({ foreground: '#111111', background: '#eeeeee' });
    fire('compositionstart');
    fire('compositionupdate', 'に');
    expect(overlay.style.display).toBe('block');
    expect(overlay.textContent).toBe('に');
    const s = overlay.style;
    expect([s.left, s.top, s.height, s.lineHeight, s.maxWidth]).toEqual([
      '94px',
      '40px',
      '20px',
      '20px',
      '710px',
    ]);
    expect([s.fontFamily, s.fontSize]).toEqual(['Menlo', '14px']);
    expect([s.color, s.background]).toEqual(['#111111', '#eeeeee']);
  });

  test("without theme colours it uses ghostty-web's defaults", () => {
    const { overlay, fire } = setup();
    fire('compositionupdate', 'a');
    expect([overlay.style.color, overlay.style.background]).toEqual(['#d4d4d4', '#1e1e1e']);
  });

  test('follows the cursor every frame while composing, and stops after the end', () => {
    const { cursor, clock, overlay, fire } = setup();
    fire('compositionstart');
    expect(clock.pending.frames).toBe(1);
    cursor.spot = { left: 103, top: 40 };
    clock.frame();
    expect(overlay.style.left).toBe('103px');
    fire('compositionend');
    expect([overlay.style.display, overlay.textContent]).toEqual(['none', '']);
    clock.frame();
    expect(clock.pending.frames).toBe(0);
  });

  test('an empty update hides the overlay; focus leaving ends the composition', () => {
    const { overlay, fire } = setup();
    fire('compositionupdate', 'ab');
    fire('compositionupdate', '');
    expect(overlay.style.display).toBe('none');
    fire('compositionupdate', 'abc');
    fire('focusout');
    expect([overlay.style.display, overlay.textContent]).toEqual(['none', '']);
  });

  test('without a cursor cell the overlay stays where it was', () => {
    const { cursor, overlay, fire, composer } = setup();
    fire('compositionupdate', 'a');
    cursor.spot = undefined;
    composer.update();
    expect(overlay.style.left).toBe('94px');
  });

  test('without renderer metrics or a canvas the overlay is one empty cell', () => {
    dom = createDomWindow();
    const container = dom.document.createElement('div');
    const term: ComposerTerminal = {
      getCursorCellOffset: () => ({ left: 10, top: 0 }),
      options: { fontFamily: 'Menlo', fontSize: 14 },
    };
    const composer = new Composer(
      term,
      container,
      {},
      {
        document: dom.document,
        window: { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} },
      },
    );
    composer.update();
    const overlay = container.querySelector('[data-compose]') as HTMLElement;
    expect([overlay.style.height, overlay.style.maxWidth]).toEqual(['0px', '0px']);
  });

  test('dispose removes the overlay and its listeners and cancels the frame; twice is a no-op', () => {
    const { container, clock, composer, overlay, fire } = setup();
    fire('compositionstart');
    composer.dispose();
    expect(container.contains(overlay)).toBe(false);
    expect(clock.pending.frames).toBe(0);
    fire('compositionupdate', 'a');
    expect(overlay.textContent).toBe('');
    expect(clock.pending.frames).toBe(0);
    composer.dispose();
  });
});
