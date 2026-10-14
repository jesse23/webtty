import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from './ghostty-web/ghostty';
import {
  InputHandler,
  isNewMouseCell,
  mouseMotionButton,
  plainKeySequence,
} from './ghostty-web/input-handler';
import { Key, Mods } from './ghostty-web/types';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

describe('mouseMotionButton', () => {
  test('encodes hover (no button held) as 35', () => {
    expect(mouseMotionButton(0)).toBe(35);
  });

  test('encodes a left-button drag as 32', () => {
    expect(mouseMotionButton(1)).toBe(32);
  });

  test('encodes a middle-button drag as 33', () => {
    expect(mouseMotionButton(2)).toBe(33);
  });

  test('encodes a right-button drag as 34', () => {
    expect(mouseMotionButton(4)).toBe(34);
  });

  test('reports the lowest button when several are held', () => {
    expect(mouseMotionButton(1 | 4)).toBe(32);
    expect(mouseMotionButton(2 | 4)).toBe(33);
  });
});

describe('isNewMouseCell', () => {
  test('reports the first motion when nothing was reported yet', () => {
    expect(isNewMouseCell(null, { col: 8, row: 4 })).toBe(true);
  });

  test('drops motion within the last reported cell', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 8, row: 4 })).toBe(false);
  });

  test('reports motion into a new column', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 9, row: 4 })).toBe(true);
  });

  test('reports motion into a new row', () => {
    expect(isNewMouseCell({ col: 8, row: 4 }, { col: 8, row: 5 })).toBe(true);
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
        hasSgrMouseMode: () => true,
        getCellDimensions: () => ({ width: 8, height: 16 }),
        getCanvasOffset: () => ({ left: 10, top: 10 }),
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
