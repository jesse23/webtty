import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../test-support/dom-window';
import { ManualClock } from '../../test-support/manual-clock';
import { FIND_DELAY_MS, FindBar } from './find-bar';
import type { FieldKeyEvent } from './find-keys';

let dom: DomWindow;
afterEach(() => dom.close());

/** A bar in a fresh happy-dom body, its requests logged, its delay on a manual clock. */
function setup(theme: Record<string, string | undefined> = {}) {
  dom = createDomWindow();
  const { document, window } = dom;
  const clock = new ManualClock();
  const calls: string[] = [];
  // Ctrl+G and Ctrl+Shift+G stand in for the keyboard feature's find shortcuts.
  const lookup = (e: FieldKeyEvent) =>
    e.ctrlKey && e.code === 'KeyG' ? (e.shiftKey ? 'findPrevious' : 'findNext') : undefined;
  const bar = new FindBar(
    document.body,
    theme,
    lookup,
    {
      find: (needle) => calls.push(`find:${needle}`),
      next: () => calls.push('next'),
      previous: () => calls.push('previous'),
      close: () => calls.push('close'),
    },
    {
      document,
      setTimeout: clock.setTimeout,
      clearTimeout: (id) => clock.clearTimeout(id as number),
    },
  );
  const root = document.querySelector('.find-bar') as HTMLElement;
  const input = document.getElementById('find-bar-input') as HTMLInputElement;
  const buttons = [...root.querySelectorAll('button')];
  const count = root.querySelector('.find-bar-count') as HTMLElement;
  const status = root.querySelector('[role="status"]') as HTMLElement;
  const type = (text: string) => {
    input.value = text;
    input.dispatchEvent(new window.Event('input'));
  };
  const key = (init: KeyboardEventInit) => {
    const event = new window.KeyboardEvent('keydown', { cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  };
  return { document, bar, clock, calls, root, input, buttons, count, status, type, key };
}

describe('FindBar', () => {
  test('builds a hidden, labelled search region in the parent, coloured from the theme', () => {
    const { document, root, input, buttons, count, status } = setup({
      background: '#000',
      foreground: '#fff',
      brightBlack: '#888',
    });
    expect(root.parentElement).toBe(document.body);
    expect(root.hidden).toBe(true);
    expect(root.getAttribute('role')).toBe('search');
    expect(document.querySelector('label')?.htmlFor).toBe('find-bar-input');
    expect(input.placeholder).toBe('Find…');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Next match (older)',
      'Previous match (newer)',
      'Close',
    ]);
    expect(root.style.getPropertyValue('--find-bg')).toBe('#000');
    expect(root.style.getPropertyValue('--find-fg')).toBe('#fff');
    expect(root.style.getPropertyValue('--find-border')).toBe('#888');
    expect(count.textContent).toBe('0/0');
    expect(status.textContent).toBe('No matches');
  });

  test('the border falls back to the foreground, and a theme without colours sets none', async () => {
    expect(setup({ foreground: '#eee' }).root.style.getPropertyValue('--find-border')).toBe('#eee');
    await dom.close();
    const { root } = setup();
    expect(root.getAttribute('style') ?? '').toBe('');
  });

  test('open shows the bar with the field focused; close hides it and ends the search', () => {
    const { document, bar, calls, root, input } = setup();
    bar.open();
    expect([bar.isOpen, root.hidden]).toEqual([true, false]);
    expect(document.activeElement).toBe(input);
    // An empty field is not searched.
    expect(calls).toEqual([]);
    bar.close();
    expect([bar.isOpen, root.hidden]).toEqual([false, true]);
    expect(calls).toEqual(['close']);
    bar.close();
    expect(calls).toEqual(['close']);
  });

  test('typing searches after the delay, restarted by each keystroke', () => {
    const { bar, clock, calls, type } = setup();
    bar.open();
    type('a');
    clock.advance(FIND_DELAY_MS - 1);
    type('ab');
    clock.advance(FIND_DELAY_MS - 1);
    expect(calls).toEqual([]);
    clock.advance(1);
    expect(calls).toEqual(['find:ab']);
  });

  test('reopened, it searches the text it kept again', () => {
    const { bar, clock, calls, type } = setup();
    bar.open();
    type('abc');
    clock.advance(FIND_DELAY_MS);
    bar.close();
    bar.open();
    expect(calls).toEqual(['find:abc', 'close', 'find:abc']);
    // Open while open only refocuses.
    bar.open();
    expect(calls).toHaveLength(3);
  });

  test('closing drops a pending search', () => {
    const { bar, clock, calls, type } = setup();
    bar.open();
    type('abc');
    bar.close();
    clock.advance(FIND_DELAY_MS);
    expect(calls).toEqual(['close']);
  });

  test('go searches pending text first, then steps; it does nothing while closed', () => {
    const { bar, clock, calls, type } = setup();
    bar.go('next');
    expect(calls).toEqual([]);
    bar.open();
    type('x');
    bar.go('next');
    bar.go('previous');
    expect(calls).toEqual(['find:x', 'next', 'previous']);
    clock.advance(FIND_DELAY_MS);
    expect(calls).toHaveLength(3);
  });

  test('Enter, Shift+Enter, the find shortcuts and Escape in the field', () => {
    const { bar, calls, key } = setup();
    bar.open();
    expect(key({ key: 'Enter', code: 'Enter' }).defaultPrevented).toBe(true);
    key({ key: 'Enter', code: 'Enter', shiftKey: true });
    key({ key: 'g', code: 'KeyG', ctrlKey: true });
    key({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(calls).toEqual(['next', 'previous', 'next', 'previous']);
    // A key that is the field's own is left alone.
    expect(key({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
    key({ key: 'Escape', code: 'Escape', ctrlKey: false });
    expect(calls.at(-1)).toBe('previous');
  });

  test('Escape closes, through the lookup', () => {
    dom = createDomWindow();
    const { document, window } = dom;
    const calls: string[] = [];
    const bar = new FindBar(
      document.body,
      {},
      (e) => (e.key === 'Escape' ? 'findClose' : e.key === 'F3' ? 'find' : undefined),
      {
        find: () => calls.push('find'),
        next: () => calls.push('next'),
        previous: () => calls.push('previous'),
        close: () => calls.push('close'),
      },
      { document, setTimeout: () => 0, clearTimeout: () => {} },
    );
    bar.open();
    const input = document.getElementById('find-bar-input') as HTMLInputElement;
    input.value = 'abc';
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F3', cancelable: true }));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(calls).toEqual(['close']);
    expect(bar.isOpen).toBe(false);
  });

  test('while composing (IME), Enter commits the text and is not a search step', () => {
    const { bar, calls, key } = setup();
    bar.open();
    const event = key({ key: 'Enter', code: 'Enter', isComposing: true });
    expect(event.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });

  test('the buttons step and close', () => {
    const { bar, calls, buttons } = setup();
    bar.open();
    for (const b of buttons) b.click();
    expect(calls).toEqual(['next', 'previous', 'close']);
  });

  test('update writes the count, and the live region only when the words change', () => {
    const { bar, count, status } = setup();
    const writes: string[] = [];
    // Log every write to the live region: a screen reader announces each one.
    let proto = Object.getPrototypeOf(status);
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'textContent')) {
      proto = Object.getPrototypeOf(proto);
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'textContent');
    Object.defineProperty(status, 'textContent', {
      get: () => descriptor?.get?.call(status),
      set: (value: string) => {
        writes.push(value);
        descriptor?.set?.call(status, value);
      },
    });
    bar.update({ total: 3, selected: null });
    bar.update({ total: 3, selected: null });
    bar.update({ total: 3, selected: 1 });
    expect(count.textContent).toBe('2/3');
    expect(status.textContent).toBe('Match 2 of 3');
    expect(writes).toEqual(['3 matches', 'Match 2 of 3']);
  });

  test('dispose removes the bar and its listeners and drops a pending search; twice is a no-op', () => {
    const { document, bar, clock, calls, input, buttons, type } = setup();
    bar.open();
    type('abc');
    bar.dispose();
    expect(document.querySelector('.find-bar')).toBeNull();
    expect(clock.pending.timers).toBe(0);
    type('abcd');
    buttons[0].click();
    expect(clock.pending.timers).toBe(0);
    expect(calls).toEqual([]);
    bar.dispose();
    expect(input.isConnected).toBe(false);
  });
});
