import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { type DisposableParts, disposeParts } from '../../ghostty-web/core/opened-parts';

// The teardown of what Terminal.open() made: the whole set, or the part a failed open()
// got to.

let dom: DomWindow;
afterEach(async () => {
  await dom.close();
});

/** Every part on fakes that log their teardown, the DOM ones in a happy-dom container. */
function parts() {
  dom = createDomWindow();
  const log: string[] = [];
  const container = dom.document.createElement('div');
  const canvas = dom.document.createElement('canvas');
  const textarea = dom.document.createElement('textarea');
  container.append(canvas, textarea);
  const disposable = (name: string) => ({ dispose: () => void log.push(name) });
  const all: DisposableParts = {
    element: container,
    engine: { free: () => void log.push('engine') },
    canvas,
    textarea,
    renderer: disposable('renderer'),
    input: disposable('input'),
    selection: disposable('selection'),
    links: disposable('links'),
  };
  return { all, log, container };
}

describe('disposeParts', () => {
  test('disposes each part in order and takes the canvas and textarea out', () => {
    const { all, log, container } = parts();
    disposeParts(all);
    expect(log).toEqual(['selection', 'input', 'renderer', 'links', 'engine']);
    expect(container.children.length).toBe(0);
  });

  test('skips the parts a failed open() never made', () => {
    const { all, log, container } = parts();
    disposeParts({ element: all.element, engine: all.engine, canvas: all.canvas });
    expect(log).toEqual(['engine']);
    expect([...container.children].map((c) => c.tagName)).toEqual(['TEXTAREA']);
  });

  test('a canvas already out of the DOM is left as it is', () => {
    const { all, log, container } = parts();
    const canvas = container.firstChild;
    canvas?.remove();
    disposeParts({ canvas: canvas ?? undefined, links: all.links });
    expect(log).toEqual(['links']);
  });
});
