import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { ManualClock } from '../../../test-support/manual-clock';
import type { Ghostty } from '../../ghostty-web/ghostty';
import { Key, KeyAction, type KeyEvent, Mods } from '../../ghostty-web/input/key-types';
import {
  InputHandler,
  type InputHandlerOptions,
  type MouseEventReport,
  type MouseTrackingConfig,
} from '../../ghostty-web/input-handler';
import { loadGhostty } from '../support/wasm';

// The InputHandler facade (ADR 061): its listeners, and what keys, IME compositions,
// beforeinput and mouse events send through it.

let ghostty: Ghostty;
let dom: DomWindow;
let container: HTMLElement;
let textarea: HTMLTextAreaElement;
let sent: string[];
let reports: boolean[];

beforeAll(async () => {
  ghostty = await loadGhostty();
});

beforeEach(() => {
  dom = createDomWindow();
  container = dom.document.createElement('div');
  textarea = dom.document.createElement('textarea');
  container.append(textarea);
  dom.document.body.append(container);
  sent = [];
  reports = [];
});

afterEach(() => dom.close());

/** An InputHandler on the test's container and textarea, recording what it sends. */
function handler(
  options: Partial<InputHandlerOptions> & { appCursor?: boolean } = {},
): InputHandler {
  const { appCursor, ...rest } = options;
  return new InputHandler({
    ghostty,
    container,
    onData: (data, mouseReport) => {
      sent.push(data);
      reports.push(mouseReport ?? false);
    },
    getMode: (mode) => mode === 1 && !!appCursor,
    inputElement: textarea,
    ...rest,
  });
}

/** Fires a keydown on the container; returns whether it was prevented and whether it propagated. */
function keydown(code: string, key: string, init: KeyboardEventInit = {}) {
  const event = new dom.window.KeyboardEvent('keydown', {
    code,
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  let propagated = false;
  const listener = () => {
    propagated = true;
  };
  dom.document.body.addEventListener('keydown', listener);
  container.dispatchEvent(event);
  dom.document.body.removeEventListener('keydown', listener);
  return { prevented: event.defaultPrevented, propagated };
}

/** Fires a beforeinput on the textarea; returns whether it was prevented. */
function beforeinput(inputType: string, data: string | null, isComposing = false): boolean {
  const event = new dom.window.InputEvent('beforeinput', {
    inputType,
    data,
    isComposing,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Fires a composition event on the container (happy-dom's CompositionEvent drops `data`). */
function composition(type: string, data = ''): void {
  container.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true }), { data }));
}

describe('InputHandler set-up and teardown', () => {
  test('makes the container focusable with no outline, keeping its own tabindex', () => {
    handler();
    expect(container.getAttribute('tabindex')).toBe('0');
    // happy-dom reads the shorthand back as 'none none'
    expect(container.style.outline).toStartWith('none');
    container.setAttribute('tabindex', '-1');
    handler();
    expect(container.getAttribute('tabindex')).toBe('-1');
  });

  test('dispose() removes every listener, and a second call does nothing', () => {
    const add = [
      spyOn(container, 'addEventListener'),
      spyOn(textarea, 'addEventListener'),
      spyOn(dom.document, 'addEventListener'),
    ];
    const remove = [
      spyOn(container, 'removeEventListener'),
      spyOn(textarea, 'removeEventListener'),
      spyOn(dom.document, 'removeEventListener'),
    ];
    const input = handler();
    const added = add.map((spy) => spy.mock.calls.map(([type]) => type));
    expect(added).toEqual([
      ['keydown', 'compositionstart', 'compositionend', 'mousedown'],
      ['beforeinput'],
      ['mouseup', 'mousemove'],
    ]);
    input.dispose();
    const removed = remove.map((spy) => spy.mock.calls.map(([type]) => type).sort());
    expect(removed).toEqual(added.map((types) => [...types].sort()));
    input.dispose();
    expect(remove.map((spy) => spy.mock.calls.length)).toEqual([4, 1, 2]);
    // Nothing is sent after dispose
    keydown('KeyA', 'a');
    expect(sent).toEqual([]);
  });

  test('without an input element there is no beforeinput listener', () => {
    const spy = spyOn(container, 'addEventListener');
    new InputHandler({ ghostty, container, onData: (data) => sent.push(data) }).dispose();
    expect(spy.mock.calls.map(([type]) => type)).not.toContain('beforeinput');
  });
});

describe('InputHandler keys', () => {
  test('a printable key is sent as it is and prevented', () => {
    handler();
    expect(keydown('KeyA', 'a')).toEqual({ prevented: true, propagated: true });
    expect(keydown('KeyA', 'A', { shiftKey: true }).prevented).toBe(true);
    expect(sent).toEqual(['a', 'A']);
  });

  test('an encoded key is prevented and stopped', () => {
    handler();
    expect(keydown('ArrowUp', 'ArrowUp')).toEqual({ prevented: true, propagated: false });
    expect(keydown('KeyC', 'c', { ctrlKey: true })).toEqual({ prevented: true, propagated: false });
    expect(sent).toEqual(['\x1b[A', '\x03']);
  });

  test('Shift+Enter is CR, prevented but not stopped', () => {
    handler();
    expect(keydown('Enter', 'Enter', { shiftKey: true })).toEqual({
      prevented: true,
      propagated: true,
    });
    expect(sent).toEqual(['\r']);
  });

  test('Ctrl+V and Cmd+V pass through to the browser paste', () => {
    handler();
    expect(keydown('KeyV', 'v', { ctrlKey: true })).toEqual({ prevented: false, propagated: true });
    expect(keydown('KeyV', 'v', { metaKey: true }).prevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test('Cmd+C copies a selection and is prevented; with none it passes through', () => {
    let selection = true;
    handler({ onCopy: () => selection });
    expect(keydown('KeyC', 'c', { metaKey: true }).prevented).toBe(true);
    selection = false;
    expect(keydown('KeyC', 'c', { metaKey: true }).prevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test('Cmd+C with no copy callback passes through', () => {
    handler();
    expect(keydown('KeyC', 'c', { metaKey: true }).prevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test('keyCode 229 and composing keydowns are the IME’s', () => {
    handler();
    expect(keydown('KeyA', 'a', { keyCode: 229 }).prevented).toBe(false);
    expect(keydown('KeyA', 'a', { isComposing: true }).prevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a key the table does not know is left alone', () => {
    handler();
    expect(keydown('MediaPlayPause', 'MediaPlayPause').prevented).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a key the encoder sends nothing for is prevented and sends nothing', () => {
    handler();
    expect(keydown('CapsLock', 'CapsLock').prevented).toBe(true);
    expect(sent).toEqual([]);
  });

  test('an encoding failure is logged, not thrown, and the key is not prevented', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    handler({
      getMode: () => {
        throw new Error('freed');
      },
    });
    expect(keydown('ArrowUp', 'ArrowUp').prevented).toBe(false);
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].slice(0, 2)).toEqual(['Failed to encode key:', 'ArrowUp']);
    warn.mockRestore();
  });
});

describe('InputHandler key encoder', () => {
  test('the key encoder comes from the injected factory', () => {
    const events: KeyEvent[] = [];
    handler({
      ghostty: {
        createKeyEncoder: () => ({
          setOption: () => {},
          encode: (event) => {
            events.push(event);
            return new TextEncoder().encode('<key>');
          },
          dispose: () => {},
        }),
      },
    });
    keydown('F1', 'F1');
    expect(sent).toEqual(['<key>']);
    expect(events).toEqual([
      { action: KeyAction.PRESS, key: Key.F1, mods: Mods.NONE, utf8: undefined },
    ]);
  });
});

describe('InputHandler key bytes', () => {
  /** Sends a keydown through a handler and returns what it wrote, under DECCKM if asked. */
  function keys(appCursor = false) {
    handler({ appCursor });
    return (code: string, key: string, mods: string[] = []) => {
      sent = [];
      keydown(code, key, {
        shiftKey: mods.includes('shift'),
        ctrlKey: mods.includes('ctrl'),
        altKey: mods.includes('alt'),
        metaKey: mods.includes('meta'),
      });
      return sent.join('');
    };
  }

  test('Home and End follow application cursor mode, like the arrows', () => {
    const normal = keys(false);
    expect(normal('Home', 'Home')).toBe('\x1b[H');
    expect(normal('End', 'End')).toBe('\x1b[F');
    expect(normal('ArrowUp', 'ArrowUp')).toBe('\x1b[A');
    container = dom.document.createElement('div');
    const app = keys(true);
    expect(app('Home', 'Home')).toBe('\x1bOH');
    expect(app('End', 'End')).toBe('\x1bOF');
    expect(app('ArrowUp', 'ArrowUp')).toBe('\x1bOA');
  });

  test('navigation keys carry their modifiers', () => {
    const send = keys();
    expect(send('Home', 'Home', ['shift'])).toBe('\x1b[1;2H');
    expect(send('End', 'End', ['ctrl'])).toBe('\x1b[1;5F');
    expect(send('PageUp', 'PageUp')).toBe('\x1b[5~');
    expect(send('PageDown', 'PageDown')).toBe('\x1b[6~');
    expect(send('PageUp', 'PageUp', ['shift'])).toBe('\x1b[5;2~');
    expect(send('Insert', 'Insert')).toBe('\x1b[2~');
    expect(send('Delete', 'Delete')).toBe('\x1b[3~');
    expect(send('Delete', 'Delete', ['shift'])).toBe('\x1b[3;2~');
    expect(send('Delete', 'Delete', ['alt'])).toBe('\x1b[3;3~');
  });

  test('function keys carry their modifiers', () => {
    const send = keys();
    expect(send('F1', 'F1')).toBe('\x1bOP');
    expect(send('F4', 'F4')).toBe('\x1bOS');
    expect(send('F5', 'F5')).toBe('\x1b[15~');
    expect(send('F12', 'F12')).toBe('\x1b[24~');
    expect(send('F1', 'F1', ['shift'])).toBe('\x1b[1;2P');
    expect(send('F5', 'F5', ['ctrl'])).toBe('\x1b[15;5~');
  });

  test('Enter, Tab and Shift+Tab', () => {
    const send = keys();
    expect(send('Enter', 'Enter')).toBe('\r');
    expect(send('Enter', 'Enter', ['shift'])).toBe('\r');
    expect(send('Enter', 'Enter', ['alt'])).toBe('\x1b\r');
    expect(send('Tab', 'Tab')).toBe('\t');
    expect(send('Tab', 'Tab', ['shift'])).toBe('\x1b[Z');
  });

  test('Backspace sends DEL, ESC DEL with Alt and BS with Ctrl', () => {
    const send = keys();
    expect(send('Backspace', 'Backspace')).toBe('\x7f');
    expect(send('Backspace', 'Backspace', ['shift'])).toBe('\x7f');
    expect(send('Backspace', 'Backspace', ['alt'])).toBe('\x1b\x7f');
    expect(send('Backspace', 'Backspace', ['ctrl'])).toBe('\b');
  });

  test('Escape sends ESC, unmodified or with Shift', () => {
    const send = keys();
    expect(send('Escape', 'Escape')).toBe('\x1b');
    expect(send('Escape', 'Escape', ['shift'])).toBe('\x1b');
    expect(send('Escape', 'Escape', ['alt'])).toBe('\x1b\x1b');
  });

  test('Alt and Ctrl letters', () => {
    const send = keys();
    // The encoder's Alt-ESC prefix option is never set, so Alt+letter is the letter
    expect(send('KeyA', 'a', ['alt'])).toBe('a');
    expect(send('KeyZ', 'z', ['ctrl'])).toBe('\x1a');
    // AltGr types its character
    expect(send('KeyE', '€', ['ctrl', 'alt'])).toBe('€');
  });

  test('keypad digits and operators send their characters', () => {
    const send = keys();
    expect(send('Numpad1', '1')).toBe('1');
    expect(send('NumpadAdd', '+')).toBe('+');
    expect(send('NumpadEnter', 'Enter')).toBe('\r');
  });
});

describe('InputHandler beforeinput', () => {
  test('text, line breaks and deletes are sent and prevented', () => {
    handler();
    expect(beforeinput('insertText', 'a\nb')).toBe(true);
    expect(beforeinput('insertReplacementText', 'word')).toBe(true);
    expect(beforeinput('insertLineBreak', null)).toBe(true);
    expect(beforeinput('insertParagraph', null)).toBe(true);
    expect(beforeinput('deleteContentBackward', null)).toBe(true);
    expect(beforeinput('deleteContentForward', null)).toBe(true);
    expect(sent).toEqual(['a\rb', 'word', '\r', '\r', '\x7F', '\x1B[3~']);
  });

  test('other input types and empty text are left to the browser', () => {
    handler();
    expect(beforeinput('insertText', '')).toBe(false);
    expect(beforeinput('insertText', null)).toBe(false);
    expect(beforeinput('deleteWordBackward', null)).toBe(false);
    expect(beforeinput('formatBold', null)).toBe(false);
    expect(sent).toEqual([]);
  });

  test('a beforeinput during a composition is the IME’s', () => {
    handler();
    expect(beforeinput('insertText', 'a', true)).toBe(false);
    composition('compositionstart');
    expect(beforeinput('insertText', 'a')).toBe(false);
    expect(sent).toEqual([]);
  });

  test('the beforeinput echo of a keydown is prevented but not sent again', () => {
    handler();
    keydown('KeyA', 'a');
    expect(beforeinput('insertText', 'a')).toBe(true);
    // The keydown is forgotten after one check
    expect(beforeinput('insertText', 'a')).toBe(true);
    expect(sent).toEqual(['a', 'a']);
  });

  test('the echo window is 100 ms on the injected clock', () => {
    const clock = new ManualClock();
    handler({ now: clock.now });
    keydown('KeyA', 'a');
    clock.advance(99);
    beforeinput('insertText', 'a');
    keydown('KeyA', 'a');
    clock.advance(100);
    beforeinput('insertText', 'a');
    expect(sent).toEqual(['a', 'a', 'a']);
  });

  test('a different beforeinput after a keydown is sent', () => {
    handler();
    keydown('KeyA', 'a');
    beforeinput('insertText', 'á');
    expect(sent).toEqual(['a', 'á']);
  });

  // Paste is webtty's capture listener's (ADR 037), so the handler's own path never ran.
  test('sends nothing for a paste or an insertFromPaste beforeinput', () => {
    handler();
    container.dispatchEvent(new dom.window.Event('paste', { bubbles: true, cancelable: true }));
    expect(beforeinput('insertFromPaste', 'a\nb')).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('InputHandler composition', () => {
  test('a composition sends its text at the end, not its keydowns', () => {
    handler();
    composition('compositionstart');
    expect(keydown('KeyN', 'n').prevented).toBe(false);
    composition('compositionupdate', 'に');
    composition('compositionend', '日本');
    expect(sent).toEqual(['日本']);
    // Keys reach the terminal again after the composition
    keydown('KeyA', 'a');
    expect(sent).toEqual(['日本', 'a']);
  });

  test('an empty composition sends nothing', () => {
    handler();
    composition('compositionstart');
    composition('compositionend', '');
    expect(sent).toEqual([]);
  });

  test('the text nodes a composition leaves in the container are removed', () => {
    handler();
    composition('compositionstart');
    container.append('日本');
    composition('compositionend', '日本');
    expect([...container.childNodes]).toEqual([textarea]);
    // Also when the composition was an echo
    beforeinput('insertText', 'x');
    container.append('x');
    composition('compositionend', 'x');
    expect([...container.childNodes]).toEqual([textarea]);
  });

  test('the beforeinput echo of a composition is prevented but not sent again', () => {
    handler();
    composition('compositionstart');
    composition('compositionend', '日本');
    expect(beforeinput('insertText', '日本')).toBe(true);
    // Remembered only until it is matched
    beforeinput('insertText', '日本');
    expect(sent).toEqual(['日本', '日本']);
  });

  test('a composition end repeating a beforeinput is not sent again', () => {
    handler();
    beforeinput('insertText', 'é');
    composition('compositionend', 'é');
    expect(sent).toEqual(['é']);
  });
});

describe('InputHandler mouse', () => {
  function tracking(): MouseTrackingConfig & { encoded: MouseEventReport[] } {
    const encoded: MouseEventReport[] = [];
    return {
      encoded,
      hasMouseTracking: () => true,
      encode: (event) => {
        encoded.push(event);
        return `<${event.action}:${event.button}>`;
      },
    };
  }

  function mouse(target: EventTarget, type: string, init: MouseEventInit = {}): void {
    target.dispatchEvent(
      new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  }

  test('presses on the container, moves and releases on the document, as mouse reports', () => {
    const config = tracking();
    handler({ mouseConfig: config });
    mouse(container, 'mousedown', { button: 0, buttons: 1 });
    mouse(dom.document.body, 'mousemove', { buttons: 1, clientX: -40 });
    mouse(dom.document.body, 'mouseup', { button: 0 });
    expect(sent).toEqual(['<press:left>', '<motion:left>', '<release:left>']);
    expect(reports).toEqual([true, true, true]);
    expect(config.encoded[1]).toMatchObject({ clientX: -40, anyButtonPressed: true });
  });

  // The terminal's own wheel listener, paced, is the only wheel path: one here also fired
  // for a wheel over the padding, where the container is the target, and sent the tick
  // twice.
  test('sends nothing for a wheel event on the container, even with mouse tracking', () => {
    handler({ mouseConfig: tracking() });
    container.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: 40, bubbles: true }));
    expect(sent).toEqual([]);
  });
});
