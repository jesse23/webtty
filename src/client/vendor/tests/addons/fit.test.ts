import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { FitAddon, fitDimensions } from '../../ghostty-web/addons/fit';

const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const pad = (p: number) => ({ top: p, right: p, bottom: p, left: p });

describe('fitDimensions', () => {
  test('uses the whole container width, with no scrollbar reserve', () => {
    // 800px / 10px = exactly 80 columns; a 15px reserve would give 78.
    expect(fitDimensions(800, 400, NONE, 10, 20)).toEqual({ cols: 80, rows: 20 });
  });

  test('floors to whole cells', () => {
    expect(fitDimensions(809, 419, NONE, 10, 20)).toEqual({ cols: 80, rows: 20 });
    expect(fitDimensions(799, 399, NONE, 10, 20)).toEqual({ cols: 79, rows: 19 });
  });

  test('handles fractional cell sizes', () => {
    expect(fitDimensions(1000, 500, NONE, 8.4, 17)).toEqual({ cols: 119, rows: 29 });
  });

  test('subtracts the padding on each side', () => {
    // 800px - 2 x 10px = 780px -> 78 cols; 400px - 2 x 10px = 380px -> 19 rows.
    expect(fitDimensions(800, 400, pad(10), 10, 20)).toEqual({ cols: 78, rows: 19 });
    // Sides are independent: 800 - 5 - 15 = 780 -> 78; 400 - 0 - 40 = 360 -> 18.
    expect(fitDimensions(800, 400, { top: 0, right: 15, bottom: 40, left: 5 }, 10, 20)).toEqual({
      cols: 78,
      rows: 18,
    });
  });

  test('never goes below the minimum grid', () => {
    expect(fitDimensions(5, 5, NONE, 10, 20)).toEqual({ cols: 2, rows: 1 });
    expect(fitDimensions(100, 100, pad(60), 10, 20)).toEqual({ cols: 2, rows: 1 });
  });
});

// webtty sizes the grid from proposeDimensions alone (ADR 033).
describe('FitAddon.proposeDimensions', () => {
  let dom: DomWindow;
  beforeEach(() => {
    dom = createDomWindow();
  });
  afterEach(() => dom.close());

  /** A container with a client size, its padding read from its computed style. */
  function container(width: number, height: number, padding = '10px') {
    const element = dom.document.createElement('div');
    Object.defineProperty(element, 'clientWidth', { value: width });
    Object.defineProperty(element, 'clientHeight', { value: height });
    element.style.padding = padding;
    // Computed styles are read for elements in the document
    dom.document.body.appendChild(element);
    return element;
  }
  const renderer = (width: number, height: number) => ({
    getMetrics: () => ({ width, height }),
  });
  const addon = () => new FitAddon((element) => dom.window.getComputedStyle(element));

  test("fits the element's client size, less its padding, in renderer cells", () => {
    const fit = addon();
    expect(fit.proposeDimensions()).toBeUndefined();
    fit.activate({ element: container(820, 420), renderer: renderer(10, 20) });
    expect(fit.proposeDimensions()).toEqual({ cols: 80, rows: 20 });
    fit.dispose();
    expect(fit.proposeDimensions()).toBeUndefined();
  });

  test('reads each side of the padding, and none as 0', () => {
    const fit = addon();
    fit.activate({ element: container(800, 400, '0 15px 40px 5px'), renderer: renderer(10, 20) });
    expect(fit.proposeDimensions()).toEqual({ cols: 78, rows: 18 });
    fit.activate({ element: container(800, 400, ''), renderer: renderer(10, 20) });
    expect(fit.proposeDimensions()).toEqual({ cols: 80, rows: 20 });
  });

  test.each([
    ['no element', () => ({ renderer: renderer(10, 20) })],
    ['no renderer (before open)', () => ({ element: container(800, 400) })],
    [
      'a renderer with no cell yet',
      () => ({ element: container(800, 400), renderer: renderer(0, 20) }),
    ],
    ['a zero-height cell', () => ({ element: container(800, 400), renderer: renderer(10, 0) })],
  ])('proposes nothing with %s', (_name, terminal) => {
    const fit = addon();
    fit.activate(terminal());
    expect(fit.proposeDimensions()).toBeUndefined();
  });

  test('proposes nothing for a container not laid out (zero size)', () => {
    const fit = addon();
    fit.activate({ element: container(0, 400), renderer: renderer(10, 20) });
    expect(fit.proposeDimensions()).toBeUndefined();
    fit.activate({ element: container(800, 0), renderer: renderer(10, 20) });
    expect(fit.proposeDimensions()).toBeUndefined();
  });

  test("reads the window's computed style by default", () => {
    const win = globalThis.window;
    const read: unknown[] = [];
    globalThis.window = {
      getComputedStyle: (element: unknown) => {
        read.push(element);
        return { getPropertyValue: () => '10px' };
      },
    } as unknown as Window & typeof globalThis;
    try {
      const element = container(820, 420);
      const fit = new FitAddon();
      fit.activate({ element, renderer: renderer(10, 20) });
      expect(fit.proposeDimensions()).toEqual({ cols: 80, rows: 20 });
      expect(read).toEqual([element]);
    } finally {
      globalThis.window = win;
    }
  });
});
