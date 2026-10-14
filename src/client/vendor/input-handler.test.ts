import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import {
  InputHandler,
  type MouseEventReport,
  motionButton,
  mouseMods,
  plainKeySequence,
} from './ghostty-web/input-handler';
import { Key, Mods } from './ghostty-web/types';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

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

describe('InputHandler mouse', () => {
  type Listener = (e: object) => void;
  const target = () => {
    const listeners = new Map<string, Listener[]>();
    return {
      listeners,
      addEventListener: (type: string, listener: Listener) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: (type: string, listener: Listener) =>
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((l) => l !== listener),
        ),
      fire: (type: string, e: object) => {
        for (const l of listeners.get(type) ?? []) l(e);
      },
    };
  };

  async function setup() {
    const ghostty = await Ghostty.load(WASM);
    const doc = target();
    const outside = {};
    const container = {
      ...target(),
      ownerDocument: doc,
      contains: (node: unknown) => node !== outside,
    };
    const encoded: MouseEventReport[] = [];
    const sent: string[] = [];
    const handler = new InputHandler(
      ghostty,
      container as unknown as HTMLElement,
      (data) => sent.push(data),
      undefined,
      undefined,
      undefined,
      {
        hasMouseTracking: () => true,
        encode: (event) => {
          encoded.push(event);
          return `<${event.action}:${event.button}>`;
        },
      },
    );
    const mouse = (over: boolean, extra: object) => {
      const prevented = { value: false };
      return {
        prevented,
        event: {
          target: over ? container : outside,
          button: 0,
          buttons: 0,
          clientX: 12,
          clientY: 34,
          shiftKey: false,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          preventDefault: () => {
            prevented.value = true;
          },
          ...extra,
        },
      };
    };
    return { handler, container, doc, encoded, sent, mouse };
  }

  test('reports a press, then a drag and its release past the terminal edge', async () => {
    const { handler, container, doc, encoded, sent, mouse } = await setup();
    container.fire('mousedown', mouse(true, { button: 0, buttons: 1, altKey: true }).event);
    doc.fire('mousemove', mouse(false, { buttons: 1, clientX: -40 }).event);
    doc.fire('mouseup', mouse(false, { button: 0, clientX: -40 }).event);
    expect(sent).toEqual(['<press:left>', '<motion:left>', '<release:left>']);
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
    handler.dispose();
    expect(doc.listeners.get('mousemove')).toEqual([]);
  });

  test('hover is reported over the terminal only, with no button', async () => {
    const { handler, doc, sent, mouse } = await setup();
    doc.fire('mousemove', mouse(true, {}).event);
    doc.fire('mousemove', mouse(false, {}).event);
    // A release outside the terminal of a button not pressed in it
    doc.fire('mouseup', mouse(false, { button: 2 }).event);
    expect(sent).toEqual(['<motion:null>']);
    handler.dispose();
  });

  // Shift is the bypass, as in Ghostty and xterm (ADR 051)
  test('a Shift drag and its release send nothing, even if Shift is let go', async () => {
    const { handler, container, doc, sent, mouse } = await setup();
    container.fire('mousedown', mouse(true, { button: 0, buttons: 1, shiftKey: true }).event);
    doc.fire('mousemove', mouse(true, { buttons: 1, clientX: 30, shiftKey: true }).event);
    doc.fire('mousemove', mouse(true, { buttons: 1, clientX: 50 }).event);
    doc.fire('mouseup', mouse(true, { button: 0, clientX: 50 }).event);
    expect(sent).toEqual([]);
    // The next press without Shift is the app's again
    container.fire('mousedown', mouse(true, { button: 0, buttons: 1 }).event);
    doc.fire('mouseup', mouse(true, { button: 0 }).event);
    expect(sent).toEqual(['<press:left>', '<release:left>']);
    handler.dispose();
  });

  test('a Shift right-click sends nothing; a right-click is the app’s', async () => {
    const { handler, container, doc, sent, mouse } = await setup();
    container.fire('mousedown', mouse(true, { button: 2, buttons: 2, shiftKey: true }).event);
    doc.fire('mouseup', mouse(true, { button: 2, shiftKey: true }).event);
    expect(sent).toEqual([]);
    container.fire('mousedown', mouse(true, { button: 2, buttons: 2 }).event);
    doc.fire('mouseup', mouse(true, { button: 2 }).event);
    expect(sent).toEqual(['<press:right>', '<release:right>']);
    handler.dispose();
  });

  test('back and forward are buttons 8 and 9, and do not navigate', async () => {
    const { handler, container, doc, sent, mouse } = await setup();
    const down = mouse(true, { button: 3, buttons: 8 });
    container.fire('mousedown', down.event);
    const up = mouse(true, { button: 4 });
    doc.fire('mouseup', up.event);
    expect(sent).toEqual(['<press:eight>', '<release:nine>']);
    expect(down.prevented.value).toBe(true);
    expect(up.prevented.value).toBe(true);
    handler.dispose();
  });
});

describe('InputHandler wheel', () => {
  // The terminal's own wheel listener, paced, is the only wheel path: one here also fired
  // for a wheel over the padding, where the container is the target, and sent the tick
  // twice.
  test('sends nothing for a wheel event on the container, even with mouse tracking', async () => {
    const ghostty = await Ghostty.load(WASM);
    const listeners = new Map<string, ((e: object) => void)[]>();
    const container = {
      addEventListener: (type: string, listener: (e: object) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    const sent: string[] = [];
    const handler = new InputHandler(
      ghostty,
      container,
      (data) => sent.push(data),
      undefined,
      undefined,
      undefined,
      {
        hasMouseTracking: () => true,
        encode: () => 'report',
      },
    );
    const wheel = { deltaY: 40, clientX: 2, clientY: 2, preventDefault: () => {} };
    for (const listener of listeners.get('wheel') ?? []) listener(wheel);
    expect(sent).toEqual([]);
    handler.dispose();
  });
});

describe('InputHandler paste', () => {
  // webtty's capture listener on the container takes every paste and stops it (ADR 037),
  // so the handler's own paste path never ran.
  test('sends nothing for a paste or an insertFromPaste beforeinput', async () => {
    const ghostty = await Ghostty.load(WASM);
    const listeners = new Map<string, ((e: object) => void)[]>();
    const element = {
      addEventListener: (type: string, listener: (e: object) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    const sent: string[] = [];
    const handler = new InputHandler(
      ghostty,
      element,
      (data) => sent.push(data),
      () => true,
      undefined,
      element,
    );
    const paste = {
      clipboardData: { getData: () => 'a\nb' },
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    for (const listener of listeners.get('paste') ?? []) listener(paste);
    const input = {
      inputType: 'insertFromPaste',
      data: 'a\nb',
      isComposing: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    for (const listener of listeners.get('beforeinput') ?? []) listener(input);
    expect(sent).toEqual([]);
    handler.dispose();
  });
});

describe('plainKeySequence', () => {
  test('sends CR and ESC for Shift+Enter and Shift+Escape, as xterm does', () => {
    expect(plainKeySequence(Key.ENTER, Mods.SHIFT)).toBe('\r');
    expect(plainKeySequence(Key.ESCAPE, Mods.SHIFT)).toBe('\x1b');
  });

  test('leaves every other key to the encoder', () => {
    for (const key of [Key.ENTER, Key.ESCAPE, Key.TAB, Key.BACKSPACE, Key.HOME, Key.F1]) {
      expect(plainKeySequence(key, Mods.NONE)).toBeNull();
      expect(plainKeySequence(key, Mods.CTRL)).toBeNull();
    }
    for (const key of [Key.TAB, Key.BACKSPACE, Key.HOME, Key.END, Key.PAGE_UP, Key.F5]) {
      expect(plainKeySequence(key, Mods.SHIFT)).toBeNull();
    }
  });
});

describe('InputHandler keys', () => {
  /** Sends a keydown through a handler and returns what it wrote, under DECCKM if asked. */
  async function keys(appCursor = false) {
    const ghostty = await Ghostty.load(WASM);
    const listeners = new Map<string, ((e: object) => void)[]>();
    const container = {
      addEventListener: (type: string, listener: (e: object) => void) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    let sent: string[] = [];
    new InputHandler(
      ghostty,
      container,
      (data) => sent.push(data),
      (mode) => mode === 1 && appCursor,
    );
    return (code: string, key: string, mods: string[] = []) => {
      sent = [];
      const e = {
        code,
        key,
        keyCode: 0,
        isComposing: false,
        shiftKey: mods.includes('shift'),
        ctrlKey: mods.includes('ctrl'),
        altKey: mods.includes('alt'),
        metaKey: mods.includes('meta'),
        preventDefault: () => {},
        stopPropagation: () => {},
      };
      for (const listener of listeners.get('keydown') ?? []) listener(e);
      return sent.join('');
    };
  }

  test('Home and End follow application cursor mode, like the arrows', async () => {
    const normal = await keys(false);
    expect(normal('Home', 'Home')).toBe('\x1b[H');
    expect(normal('End', 'End')).toBe('\x1b[F');
    expect(normal('ArrowUp', 'ArrowUp')).toBe('\x1b[A');
    const app = await keys(true);
    expect(app('Home', 'Home')).toBe('\x1bOH');
    expect(app('End', 'End')).toBe('\x1bOF');
    expect(app('ArrowUp', 'ArrowUp')).toBe('\x1bOA');
  });

  test('navigation keys carry their modifiers', async () => {
    const send = await keys();
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

  test('function keys carry their modifiers', async () => {
    const send = await keys();
    expect(send('F1', 'F1')).toBe('\x1bOP');
    expect(send('F4', 'F4')).toBe('\x1bOS');
    expect(send('F5', 'F5')).toBe('\x1b[15~');
    expect(send('F12', 'F12')).toBe('\x1b[24~');
    expect(send('F1', 'F1', ['shift'])).toBe('\x1b[1;2P');
    expect(send('F5', 'F5', ['ctrl'])).toBe('\x1b[15;5~');
  });

  test('Enter, Tab and Shift+Tab', async () => {
    const send = await keys();
    expect(send('Enter', 'Enter')).toBe('\r');
    expect(send('Enter', 'Enter', ['shift'])).toBe('\r');
    expect(send('Enter', 'Enter', ['alt'])).toBe('\x1b\r');
    expect(send('Tab', 'Tab')).toBe('\t');
    expect(send('Tab', 'Tab', ['shift'])).toBe('\x1b[Z');
  });

  test('Backspace sends DEL, ESC DEL with Alt and BS with Ctrl', async () => {
    const send = await keys();
    expect(send('Backspace', 'Backspace')).toBe('\x7f');
    expect(send('Backspace', 'Backspace', ['shift'])).toBe('\x7f');
    expect(send('Backspace', 'Backspace', ['alt'])).toBe('\x1b\x7f');
    expect(send('Backspace', 'Backspace', ['ctrl'])).toBe('\b');
  });

  test('Escape sends ESC, unmodified or with Shift', async () => {
    const send = await keys();
    expect(send('Escape', 'Escape')).toBe('\x1b');
    expect(send('Escape', 'Escape', ['shift'])).toBe('\x1b');
    expect(send('Escape', 'Escape', ['alt'])).toBe('\x1b\x1b');
  });

  test('keypad digits and operators send their characters', async () => {
    const send = await keys();
    expect(send('Numpad1', '1')).toBe('1');
    expect(send('NumpadAdd', '+')).toBe('+');
    expect(send('NumpadEnter', 'Enter')).toBe('\r');
  });
});
