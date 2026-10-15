import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { Mods } from '../../ghostty-web/input/key-types';
import {
  MOUSE_BUTTONS,
  type MouseEventReport,
  MouseReporter,
  type MouseTrackingConfig,
  motionButton,
  mouseMods,
  mouseReportText,
} from '../../ghostty-web/input/mouse-report';

// Mouse reports to the app (ADR 049, ADR 051): which presses, moves and releases reach
// Ghostty's encoder, with which button and modifiers.

describe('motionButton', () => {
  test('no button held is none, which Ghostty reports as hover (35)', () => {
    expect(motionButton(0)).toBeNull();
  });

  test('a drag reports the lowest button held', () => {
    expect(motionButton(1)).toBe('left');
    expect(motionButton(2)).toBe('middle');
    expect(motionButton(4)).toBe('right');
    expect(motionButton(1 | 4)).toBe('left');
    expect(motionButton(2 | 4)).toBe('middle');
    expect(motionButton(8)).toBe('eight');
    expect(motionButton(16)).toBe('nine');
    // A bit past the buttons Ghostty knows
    expect(motionButton(32)).toBeNull();
  });

  test('back and forward are Ghostty buttons 8 and 9', () => {
    expect(MOUSE_BUTTONS).toEqual(['left', 'middle', 'right', 'eight', 'nine']);
  });
});

describe('mouseMods', () => {
  test('passes Shift, Alt, Ctrl and Meta as their own bits', () => {
    const none = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
    expect(mouseMods(none)).toBe(Mods.NONE);
    expect(mouseMods({ ...none, altKey: true })).toBe(Mods.ALT);
    expect(mouseMods({ ...none, metaKey: true })).toBe(Mods.SUPER);
    expect(mouseMods({ ...none, shiftKey: true, ctrlKey: true })).toBe(Mods.SHIFT | Mods.CTRL);
  });
});

describe('MouseReporter', () => {
  let dom: DomWindow;
  let container: HTMLElement;
  let inner: HTMLElement;
  let outside: HTMLElement;
  let tracking: boolean;
  let encoded: MouseEventReport[];
  let sent: [string, boolean][];

  /** A reporter wired as the InputHandler wires it: presses on the container, the rest on the document. */
  function reporter(withConfig = true): MouseReporter {
    const config = withConfig ? trackingConfig() : undefined;
    const mouse = new MouseReporter(container, config, (data, report) => sent.push([data, report]));
    container.addEventListener('mousedown', (e) => mouse.down(e));
    dom.document.addEventListener('mouseup', (e) => mouse.up(e));
    dom.document.addEventListener('mousemove', (e) => mouse.move(e));
    return mouse;
  }

  function trackingConfig(): MouseTrackingConfig {
    return {
      hasMouseTracking: () => tracking,
      encode: (event) => {
        encoded.push(event);
        return event.button === 'middle' && event.action === 'motion'
          ? ''
          : `<${event.action}:${event.button}>`;
      },
    };
  }

  /** Dispatches a mouse event on `target` and returns whether it was prevented. */
  function fire(target: HTMLElement, type: string, init: MouseEventInit = {}): boolean {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 12,
      clientY: 34,
      ...init,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  }

  const data = () => sent.map(([d]) => d);

  beforeEach(() => {
    dom = createDomWindow();
    container = dom.document.createElement('div');
    inner = dom.document.createElement('canvas');
    outside = dom.document.createElement('p');
    container.append(inner);
    dom.document.body.append(container, outside);
    tracking = true;
    encoded = [];
    sent = [];
  });

  afterEach(() => dom.close());

  test('reports a press, then a drag and its release past the terminal edge', () => {
    reporter();
    fire(inner, 'mousedown', { button: 0, buttons: 1, altKey: true });
    fire(outside, 'mousemove', { buttons: 1, clientX: -40 });
    fire(outside, 'mouseup', { button: 0, clientX: -40 });
    expect(data()).toEqual(['<press:left>', '<motion:left>', '<release:left>']);
    expect(encoded[0]).toEqual({
      action: 'press',
      button: 'left',
      mods: Mods.ALT,
      clientX: 12,
      clientY: 34,
      anyButtonPressed: true,
    });
    expect(encoded[1]).toMatchObject({ clientX: -40, anyButtonPressed: true });
    expect(encoded[2]).toMatchObject({ action: 'release', anyButtonPressed: false });
  });

  test('every report is marked as a mouse report, so it leaves the selection alone', () => {
    reporter();
    fire(container, 'mousemove');
    fire(container, 'mousedown', { button: 0, buttons: 1 });
    fire(container, 'mouseup', { button: 0 });
    expect(sent.map(([, report]) => report)).toEqual([true, true, true]);
  });

  test('hover is reported over the terminal only, with no button', () => {
    reporter();
    fire(inner, 'mousemove');
    fire(outside, 'mousemove');
    // A release outside the terminal of a button not pressed in it
    fire(outside, 'mouseup', { button: 2 });
    expect(data()).toEqual(['<motion:null>']);
    // A release over the terminal is reported
    fire(container, 'mouseup', { button: 2 });
    expect(data()).toEqual(['<motion:null>', '<release:right>']);
  });

  test('an empty report is not sent', () => {
    reporter();
    fire(container, 'mousedown', { button: 1, buttons: 4 });
    fire(container, 'mousemove', { buttons: 4 });
    expect(data()).toEqual(['<press:middle>']);
    expect(encoded.map((e) => e.action)).toEqual(['press', 'motion']);
  });

  // Shift is the bypass, as in Ghostty and xterm (ADR 051)
  test('a Shift drag and its release send nothing, even if Shift is let go', () => {
    reporter();
    fire(container, 'mousedown', { button: 0, buttons: 1, shiftKey: true });
    fire(container, 'mousemove', { buttons: 1, clientX: 30, shiftKey: true });
    fire(container, 'mousemove', { buttons: 1, clientX: 50 });
    fire(container, 'mouseup', { button: 0, clientX: 50 });
    expect(data()).toEqual([]);
    // The next press without Shift is the app's again
    fire(container, 'mousedown', { button: 0, buttons: 1 });
    fire(container, 'mouseup', { button: 0 });
    expect(data()).toEqual(['<press:left>', '<release:left>']);
  });

  test('a Shift right-click sends nothing; a right-click is the app’s', () => {
    reporter();
    fire(container, 'mousedown', { button: 2, buttons: 2, shiftKey: true });
    fire(container, 'mouseup', { button: 2, shiftKey: true });
    expect(data()).toEqual([]);
    fire(container, 'mousedown', { button: 2, buttons: 2 });
    fire(container, 'mouseup', { button: 2 });
    expect(data()).toEqual(['<press:right>', '<release:right>']);
  });

  test('a move with no button held forgets a release lost outside the window', () => {
    reporter();
    fire(container, 'mousedown', { button: 0, buttons: 1 });
    // The release happened outside the document: the next move holds no button
    fire(outside, 'mousemove', { buttons: 0 });
    fire(outside, 'mousemove', { buttons: 0 });
    expect(data()).toEqual(['<press:left>']);
    fire(container, 'mousedown', { button: 0, buttons: 1, shiftKey: true });
    fire(container, 'mousemove', { buttons: 0 });
    expect(data()).toEqual(['<press:left>', '<motion:null>']);
  });

  test('back and forward are buttons 8 and 9, and do not navigate', () => {
    reporter();
    expect(fire(container, 'mousedown', { button: 3, buttons: 8 })).toBe(true);
    expect(fire(container, 'mouseup', { button: 4 })).toBe(true);
    expect(data()).toEqual(['<press:eight>', '<release:nine>']);
    // A left press is left to the selection
    expect(fire(container, 'mousedown', { button: 0, buttons: 1 })).toBe(false);
  });

  test('a button Ghostty does not know is ignored', () => {
    reporter();
    fire(container, 'mousedown', { button: 5, buttons: 32 });
    fire(container, 'mouseup', { button: 5 });
    expect(data()).toEqual([]);
  });

  test('nothing is reported while the app does not track the mouse', () => {
    tracking = false;
    reporter();
    fire(container, 'mousedown', { button: 0, buttons: 1 });
    fire(container, 'mousemove', { buttons: 1 });
    fire(container, 'mouseup', { button: 0 });
    expect(encoded).toEqual([]);
  });

  test('nothing is reported without a tracking config', () => {
    reporter(false);
    fire(container, 'mousedown', { button: 0, buttons: 1 });
    fire(container, 'mousemove', { buttons: 1 });
    fire(container, 'mouseup', { button: 0 });
    expect(sent).toEqual([]);
  });
});

describe('mouseReportText', () => {
  test('passes a UTF-8 report through as text', () => {
    expect(mouseReportText(new TextEncoder().encode('\x1b[<0;1;1M'))).toBe('\x1b[<0;1;1M');
    expect(mouseReportText(new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0xc3, 0xa8, 0x23]))).toBe(
      '\x1b[M è#',
    );
  });

  test('drops a report with raw bytes above 0x7f, which text frames cannot carry', () => {
    expect(mouseReportText(new Uint8Array([0x1b, 0x5b, 0x4d, 0x20, 0x80, 0x21]))).toBe('');
  });
});
