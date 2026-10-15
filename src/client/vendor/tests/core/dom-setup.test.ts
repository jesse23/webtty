import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { recordListeners } from '../../../test-support/recording-target';
import {
  anchorTextarea,
  createInputTextarea,
  createTerminalCanvas,
  focusTextareaOnPress,
  labelContainer,
  makeContainerEditable,
  sizeCanvasElement,
  unlabelContainer,
} from '../../ghostty-web/core/dom-setup';

// The DOM Terminal.open() builds, on a happy-dom document.

let dom: DomWindow;
afterEach(async () => {
  await dom.close();
});

function setup() {
  dom = createDomWindow();
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  return { document: dom.document, window: dom.window, container };
}

describe('the container', () => {
  test('becomes focusable, contenteditable and labelled; unlabelling keeps the tabindex', () => {
    const { container } = setup();
    makeContainerEditable(container);
    labelContainer(container);
    const attributes = () =>
      Object.fromEntries([...container.attributes].map((a) => [a.name, a.value]));
    expect(attributes()).toEqual({
      tabindex: '0',
      contenteditable: 'true',
      role: 'textbox',
      'aria-label': 'Terminal input',
      'aria-multiline': 'true',
    });
    unlabelContainer(container);
    expect(attributes()).toEqual({ tabindex: '0' });
  });

  test('a tabindex already set is kept', () => {
    const { container } = setup();
    container.setAttribute('tabindex', '-1');
    makeContainerEditable(container);
    expect(container.getAttribute('tabindex')).toBe('-1');
  });

  test("the browser's own editing of the container is cancelled, a child's is not", () => {
    const { container, document, window } = setup();
    const child = document.createElement('span');
    container.appendChild(child);
    makeContainerEditable(container);
    const own = new window.InputEvent('beforeinput', { cancelable: true, bubbles: true });
    container.dispatchEvent(own);
    const childs = new window.InputEvent('beforeinput', { cancelable: true, bubbles: true });
    child.dispatchEvent(childs);
    expect([own.defaultPrevented, childs.defaultPrevented]).toEqual([true, false]);
  });

  test('its Disposable removes the cancelling listener (ADR 065)', () => {
    const { container, window } = setup();
    const recorded = recordListeners(container, 'container');
    makeContainerEditable(container).dispose();
    expect(recorded.active).toEqual([]);
    const own = new window.InputEvent('beforeinput', { cancelable: true, bubbles: true });
    container.dispatchEvent(own);
    expect(own.defaultPrevented).toBe(false);
  });
});

describe('the canvas and textarea', () => {
  test('the canvas is a block with the default arrow', () => {
    const { document } = setup();
    const canvas = createTerminalCanvas(document);
    expect([canvas.tagName, canvas.style.display, canvas.style.cursor]).toEqual([
      'CANVAS',
      'block',
      'default',
    ]);
  });

  test('the textarea is focusable, unassisted and clipped away', () => {
    const { document } = setup();
    const textarea = createInputTextarea(document);
    expect(
      ['autocorrect', 'autocapitalize', 'spellcheck', 'tabindex', 'aria-label'].map((name) =>
        textarea.getAttribute(name),
      ),
    ).toEqual(['off', 'off', 'false', '0', 'Terminal input']);
    const { style } = textarea;
    expect([style.position, style.width, style.height, style.opacity, style.clipPath]).toEqual([
      'absolute',
      '1px',
      '1px',
      '0',
      'inset(50%)',
    ]);
    expect([style.overflow, style.whiteSpace, style.resize]).toEqual(['hidden', 'nowrap', 'none']);
  });

  test('a press or a tap on the canvas focuses the textarea, default prevented', () => {
    const { document, window, container } = setup();
    const canvas = createTerminalCanvas(document);
    const textarea = createInputTextarea(document);
    container.append(canvas, textarea);
    const recorded = recordListeners(canvas, 'canvas');
    focusTextareaOnPress(canvas, textarea);
    expect(recorded.added.map((r) => r.type)).toEqual(['mousedown', 'touchend']);
    const press = new window.MouseEvent('mousedown', { cancelable: true });
    canvas.dispatchEvent(press);
    expect([press.defaultPrevented, document.activeElement]).toEqual([true, textarea]);
    textarea.blur();
    const tap = new window.Event('touchend', { cancelable: true });
    canvas.dispatchEvent(tap);
    expect([tap.defaultPrevented, document.activeElement]).toEqual([true, textarea]);
  });

  test('the press-to-focus Disposable removes both listeners, once (ADR 065)', () => {
    const { document } = setup();
    const canvas = createTerminalCanvas(document);
    const textarea = createInputTextarea(document);
    const recorded = recordListeners(canvas, 'canvas');
    const listeners = focusTextareaOnPress(canvas, textarea);
    listeners.dispose();
    listeners.dispose();
    expect(recorded.active).toEqual([]);
    expect(recorded.removed).toHaveLength(2);
  });

  test('sizeCanvasElement sizes the element to the grid', () => {
    const { document } = setup();
    const canvas = createTerminalCanvas(document);
    sizeCanvasElement(canvas, { width: 8, height: 16 }, 80, 24);
    expect([canvas.style.width, canvas.style.height]).toEqual(['640px', '384px']);
  });
});

describe('anchorTextarea', () => {
  test('moves the textarea onto the cell, one cell high', () => {
    const { document } = setup();
    const textarea = createInputTextarea(document);
    anchorTextarea(textarea, { left: 16, top: 32 }, 16);
    const { style } = textarea;
    expect([style.position, style.left, style.top, style.width, style.height]).toEqual([
      'absolute',
      '16px',
      '32px',
      '1px',
      '16px',
    ]);
  });

  test('puts back an absolute position the textarea lost', () => {
    const { document } = setup();
    const textarea = createInputTextarea(document);
    textarea.style.position = 'fixed';
    anchorTextarea(textarea, { left: 0, top: 0 }, 16);
    expect(textarea.style.position).toBe('absolute');
  });

  test('leaves the textarea alone while the right-click copy flow holds it', () => {
    const { document } = setup();
    const textarea = createInputTextarea(document);
    textarea.style.position = 'fixed';
    textarea.style.pointerEvents = 'auto';
    textarea.style.left = '300px';
    anchorTextarea(textarea, { left: 16, top: 32 }, 16);
    expect([textarea.style.position, textarea.style.left]).toEqual(['fixed', '300px']);
  });
});
