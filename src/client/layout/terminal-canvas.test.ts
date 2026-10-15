import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../test-support/dom-window';
import { TERMINAL_CANVAS, TERMINAL_CANVAS_UNDER_OVERLAY, terminalCanvas } from './terminal-canvas';

let dom: DomWindow;
beforeEach(() => {
  dom = createDomWindow();
});
afterEach(() => dom.close());

/** A container holding the canvases webtty adds, in `order`, each tagged by its role. */
function container(order: Array<'edge' | 'kitty' | 'terminal'>): HTMLElement {
  const el = dom.document.createElement('div');
  for (const role of order) {
    const canvas = dom.document.createElement('canvas');
    canvas.id = role;
    if (role !== 'terminal') canvas.dataset[role] = '';
    el.append(canvas);
  }
  return el;
}

describe('terminal-canvas', () => {
  test('the selectors are the exact strings the call sites have always used', () => {
    expect(TERMINAL_CANVAS).toBe('canvas:not([data-edge])');
    expect(TERMINAL_CANVAS_UNDER_OVERLAY).toBe('canvas:not([data-kitty]):not([data-edge])');
  });

  test('skips the edge strips by default', () => {
    expect(terminalCanvas(container(['edge', 'edge', 'terminal']))?.id).toBe('terminal');
  });

  test('the default selector takes a kitty overlay placed before the terminal canvas', () => {
    expect(terminalCanvas(container(['kitty', 'terminal']))?.id).toBe('kitty');
  });

  test('the overlay selector skips the overlay and the strips', () => {
    const el = container(['edge', 'kitty', 'terminal']);
    expect(terminalCanvas(el, TERMINAL_CANVAS_UNDER_OVERLAY)?.id).toBe('terminal');
  });

  test('is null without a terminal canvas', () => {
    expect(terminalCanvas(container(['edge']))).toBeNull();
  });
});
