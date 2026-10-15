import { describe, expect, test } from 'bun:test';
import {
  MenuSource,
  pressToApp,
  type RightClickAction,
  type RightClickBehavior,
  rightClickAction,
} from '../../ghostty-web/mouse-route';

describe('pressToApp', () => {
  test('a press is the app’s only while it tracks the mouse and Shift is up', () => {
    expect(pressToApp(true, false)).toBe(true);
    expect(pressToApp(true, true)).toBe(false);
    expect(pressToApp(false, false)).toBe(false);
    expect(pressToApp(false, true)).toBe(false);
  });
});

describe('rightClickAction', () => {
  const behaviors: RightClickBehavior[] = ['contextMenu', 'copyPaste', 'paste', 'none'];

  /** What `behavior` does when the app does not take the click. */
  const own = (behavior: RightClickBehavior, hasSelection: boolean): RightClickAction =>
    ({
      contextMenu: 'menu' as const,
      copyPaste: hasSelection ? ('copy' as const) : ('menu' as const),
      paste: 'paste' as const,
      none: 'none' as const,
    })[behavior];

  for (const tracking of [false, true]) {
    for (const shiftKey of [false, true]) {
      for (const fromKeyboard of [false, true]) {
        for (const behavior of behaviors) {
          for (const hasSelection of [false, true]) {
            const toApp = tracking && !shiftKey && !fromKeyboard;
            const expected = toApp ? 'app' : own(behavior, hasSelection);
            test(`tracking ${tracking}, shift ${shiftKey}, keyboard ${fromKeyboard}, ${behavior}, selection ${hasSelection}: ${expected}`, () => {
              expect(
                rightClickAction({ tracking, shiftKey, fromKeyboard, behavior, hasSelection }),
              ).toBe(expected);
            });
          }
        }
      }
    }
  }

  test('an unknown behaviour shows the menu', () => {
    const behavior = 'webtty' as RightClickBehavior;
    expect(
      rightClickAction({
        tracking: false,
        shiftKey: false,
        fromKeyboard: false,
        behavior,
        hasSelection: true,
      }),
    ).toBe('menu');
  });
});

describe('MenuSource', () => {
  const right = { button: 2, ctrlKey: false };

  test('a menu after a right press is from the button, on press or after release', () => {
    const s = new MenuSource();
    s.press(right);
    expect(s.fromKeyboard({ button: 2 })).toBe(false);
    // Windows: the menu comes after the release; Chrome may report button 0
    s.press(right);
    expect(s.fromKeyboard({ button: 0 })).toBe(false);
  });

  test('a macOS Ctrl+click menu is from the button', () => {
    const s = new MenuSource();
    s.press({ button: 0, ctrlKey: true });
    expect(s.fromKeyboard({ button: 0 })).toBe(false);
  });

  test('a menu with no press before it, or after a key, is from the keyboard', () => {
    const s = new MenuSource();
    expect(s.fromKeyboard({ button: 0 })).toBe(true);
    s.press(right);
    s.key();
    expect(s.fromKeyboard({ button: 0 })).toBe(true);
    s.press({ button: 0, ctrlKey: false });
    expect(s.fromKeyboard({ button: 0 })).toBe(true);
  });

  test('a press is used up by one menu', () => {
    const s = new MenuSource();
    s.press(right);
    expect(s.fromKeyboard({ button: 0 })).toBe(false);
    expect(s.fromKeyboard({ button: 0 })).toBe(true);
  });
});
