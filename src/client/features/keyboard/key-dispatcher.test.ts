import { afterEach, describe, expect, test } from 'bun:test';
import type { KeyboardBinding } from '../../app/client-config';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { recordListeners } from '../../test-support/recording-target';
import { findBinding } from './key-bindings';
import { createKeyHandler, type DispatchedKey, installKeyDispatcher } from './key-dispatcher';
import { shortcutFor } from './shortcut-map';

/** The state a key meets: the platform, the socket, the find bar, the selection, the clipboard. */
interface World {
  mac: boolean;
  socketOpen: boolean;
  barOpen: boolean;
  /** What copySelection and clearScreen return. */
  done: boolean;
  clipboard: boolean;
  bindings: KeyboardBinding[];
}

/** A keydown that logs its event calls and stops the listener chain as the DOM does. */
interface LoggedKey extends DispatchedKey {
  immediateStopped: boolean;
}

function keydown(init: Partial<KeyboardEventInit> & { code: string }, log: string[]): LoggedKey {
  const e: LoggedKey = {
    key: init.key ?? init.code,
    code: init.code,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    immediateStopped: false,
    preventDefault: () => log.push('preventDefault'),
    stopPropagation: () => log.push('stopPropagation'),
    stopImmediatePropagation: () => {
      log.push('stopImmediatePropagation');
      e.immediateStopped = true;
    },
  };
  return e;
}

/** The handles both versions act on, logging every call to `log`. */
function handles(w: World, log: string[]) {
  const answer = (call: string, result: boolean) => () => {
    log.push(call);
    return result;
  };
  return {
    term: {
      scrollToBottom: () => log.push('scrollToBottom'),
      jumpToPrompt: (delta: number) => log.push(`jumpToPrompt:${delta}`),
      copySelection: answer('copySelection', w.done),
    },
    connection: { isOpen: () => w.socketOpen, send: (data: string) => log.push(`send:${data}`) },
    findBar: {
      isOpen: w.barOpen,
      open: () => log.push('find.open'),
      close: () => log.push('find.close'),
      go: (direction: string) => log.push(`find.go:${direction}`),
    },
    clearScreen: answer('clearScreen', w.done),
    pasteFromClipboard: answer('pasteFromClipboard', w.clipboard),
  };
}

/**
 * The two container capture keydown listeners index.ts had before the dispatcher (95c4413), copied
 * from it with their globals made parameters; run in registration order on one node.
 */
function oldPair(w: World, log: string[], e: LoggedKey): void {
  const { term, connection, findBar, clearScreen, pasteFromClipboard } = handles(w, log);
  const bindingListener = () => {
    const binding = findBinding(e, w.bindings);
    if (!binding) return;
    e.preventDefault();
    e.stopPropagation();
    if (binding.chars && connection.isOpen()) {
      term.scrollToBottom();
      connection.send(binding.chars);
    }
  };
  const shortcutListener = () => {
    const shortcut = shortcutFor(e, w.mac);
    if (!shortcut || findBinding(e, w.bindings)) return;
    if (shortcut.action.startsWith('find')) {
      if (shortcut.action !== 'find' && !findBar.isOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (shortcut.action === 'find') findBar.open();
      else if (shortcut.action === 'findClose') findBar.close();
      else findBar.go(shortcut.action === 'findNext' ? 'next' : 'previous');
      return;
    }
    if (shortcut.action === 'promptPrevious' || shortcut.action === 'promptNext') {
      term.jumpToPrompt(shortcut.action === 'promptPrevious' ? -1 : 1);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (shortcut.action === 'paste') {
      if (pasteFromClipboard()) e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const done = shortcut.action === 'copy' ? term.copySelection() : clearScreen();
    if (!done && shortcut.performable) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  // stopPropagation never stops a listener on the same node; stopImmediatePropagation does.
  for (const listener of [bindingListener, shortcutListener]) {
    if (e.immediateStopped) break;
    listener();
  }
}

function newDispatcher(w: World, log: string[], e: LoggedKey): void {
  const { term, connection, findBar, clearScreen, pasteFromClipboard } = handles(w, log);
  const handle = createKeyHandler(
    { term, bindings: w.bindings, mac: w.mac },
    { connection, find: findBar, clearScreen, pasteFromClipboard },
  );
  handle(e);
}

/** What one version does with `init` in `w`: its calls, in order, the event's included. */
function run(version: typeof oldPair, w: World, init: Parameters<typeof keydown>[0]): string[] {
  const log: string[] = [];
  version(w, log, keydown(init, log));
  return log;
}

const BINDINGS: KeyboardBinding[] = [
  { key: 'Enter', mods: ['shift'], chars: '\x1b\r' },
  { key: 'q', mods: ['ctrl'], chars: '' },
  // Overrides Ghostty's find shortcut on Linux and Windows
  { key: 'F', mods: ['ctrl', 'shift'], chars: 'F!' },
];

/** Every key the dispatcher acts on, plus ones it leaves alone. */
const KEYS: [string, Parameters<typeof keydown>[0]][] = [
  ['a binding with chars', { code: 'Enter', key: 'Enter', shiftKey: true }],
  ['an empty binding', { code: 'KeyQ', key: 'q', ctrlKey: true }],
  ['a binding over a shortcut', { code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true }],
  ['Escape', { code: 'Escape', key: 'Escape' }],
  ['Ctrl+V', { code: 'KeyV', key: 'v', ctrlKey: true }],
  ['Ctrl+Shift+V', { code: 'KeyV', key: 'V', ctrlKey: true, shiftKey: true }],
  ['Shift+Insert', { code: 'Insert', key: 'Insert', shiftKey: true }],
  ['Ctrl+Shift+C', { code: 'KeyC', key: 'C', ctrlKey: true, shiftKey: true }],
  ['Ctrl+Insert', { code: 'Insert', key: 'Insert', ctrlKey: true }],
  ['Ctrl+Shift+Up', { code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true, shiftKey: true }],
  ['Ctrl+Shift+Down', { code: 'ArrowDown', key: 'ArrowDown', ctrlKey: true, shiftKey: true }],
  ['Cmd+K', { code: 'KeyK', key: 'k', metaKey: true }],
  ['Cmd+F', { code: 'KeyF', key: 'f', metaKey: true }],
  ['Cmd+Shift+F', { code: 'KeyF', key: 'F', metaKey: true, shiftKey: true }],
  ['Cmd+G', { code: 'KeyG', key: 'g', metaKey: true }],
  ['Cmd+Shift+G', { code: 'KeyG', key: 'G', metaKey: true, shiftKey: true }],
  ['Cmd+Up', { code: 'ArrowUp', key: 'ArrowUp', metaKey: true }],
  ['Cmd+Shift+Down', { code: 'ArrowDown', key: 'ArrowDown', metaKey: true, shiftKey: true }],
  ['a plain letter', { code: 'KeyA', key: 'a' }],
  ['Ctrl+C', { code: 'KeyC', key: 'c', ctrlKey: true }],
];

/** Every combination of the world's switches, with and without the bindings. */
function worlds(): World[] {
  const all: World[] = [];
  for (let bits = 0; bits < 64; bits++) {
    const on = (bit: number) => (bits & (1 << bit)) !== 0;
    all.push({
      mac: on(0),
      socketOpen: on(1),
      barOpen: on(2),
      done: on(3),
      clipboard: on(4),
      bindings: on(5) ? BINDINGS : [],
    });
  }
  return all;
}

describe('createKeyHandler is equivalent to the old binding and shortcut listener pair', () => {
  test.each(KEYS)('%s, in every state', (_name, init) => {
    for (const w of worlds()) {
      expect({ w, calls: run(newDispatcher, w, init) }).toEqual({
        w,
        calls: run(oldPair, w, init),
      });
    }
  });
});

describe('createKeyHandler', () => {
  const world: World = {
    mac: false,
    socketOpen: true,
    barOpen: false,
    done: false,
    clipboard: true,
    bindings: BINDINGS,
  };

  test.each<[string, Partial<World>, Parameters<typeof keydown>[0], string[]]>([
    [
      'a binding scrolls to the bottom and sends its chars (ADR 018, ADR 055)',
      {},
      { code: 'Enter', key: 'Enter', shiftKey: true },
      ['preventDefault', 'stopPropagation', 'scrollToBottom', 'send:\x1b\r'],
    ],
    [
      'a binding sends nothing while the socket is closed',
      { socketOpen: false },
      { code: 'Enter', key: 'Enter', shiftKey: true },
      ['preventDefault', 'stopPropagation'],
    ],
    [
      'an empty binding only consumes the key',
      {},
      { code: 'KeyQ', key: 'q', ctrlKey: true },
      ['preventDefault', 'stopPropagation'],
    ],
    [
      'a binding overrides a shortcut',
      {},
      { code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true },
      ['preventDefault', 'stopPropagation', 'scrollToBottom', 'send:F!'],
    ],
    [
      'the shortcut runs without the binding',
      { bindings: [] },
      { code: 'KeyF', key: 'F', ctrlKey: true, shiftKey: true },
      ['preventDefault', 'stopImmediatePropagation', 'find.open'],
    ],
    ['Escape is the app’s while the bar is closed', {}, { code: 'Escape', key: 'Escape' }, []],
    [
      'Escape closes an open bar',
      { barOpen: true },
      { code: 'Escape', key: 'Escape' },
      ['preventDefault', 'stopImmediatePropagation', 'find.close'],
    ],
    [
      'a performable copy with nothing selected falls through to the app',
      {},
      { code: 'KeyC', key: 'C', ctrlKey: true, shiftKey: true },
      ['copySelection'],
    ],
    [
      'a performable clear on the alternate screen falls through to the app',
      { mac: true },
      { code: 'KeyK', key: 'k', metaKey: true },
      ['clearScreen'],
    ],
    [
      'Ctrl+V reads the clipboard and consumes the key',
      {},
      { code: 'KeyV', key: 'v', ctrlKey: true },
      ['pasteFromClipboard', 'preventDefault', 'stopImmediatePropagation'],
    ],
    [
      'Ctrl+V without the clipboard API leaves the browser’s paste to run',
      { clipboard: false },
      { code: 'KeyV', key: 'v', ctrlKey: true },
      ['pasteFromClipboard', 'stopImmediatePropagation'],
    ],
    [
      'jump to prompt is consumed (ADR 057)',
      { mac: true },
      { code: 'ArrowUp', key: 'ArrowUp', metaKey: true },
      ['jumpToPrompt:-1', 'preventDefault', 'stopImmediatePropagation'],
    ],
    ['any other key is left alone', {}, { code: 'KeyA', key: 'a' }, []],
  ])('%s', (_name, change, init, calls) => {
    expect(run(newDispatcher, { ...world, ...change }, init)).toEqual(calls);
  });
});

describe('installKeyDispatcher', () => {
  let fake: FakeContext;
  afterEach(() => fake.dom.close());

  /** The dispatcher on a context whose container's listeners are recorded. */
  function setup() {
    fake = fakeContext({ keyboardBindings: [{ key: 'k', mods: ['ctrl'], chars: 'K!' }] });
    const container = recordListeners(fake.container, 'container');
    const sent: string[] = [];
    const feature = installKeyDispatcher(fake.ctx, {
      connection: { isOpen: () => true, send: (data) => sent.push(data) },
      find: { isOpen: false, open: () => {}, close: () => {}, go: () => {} },
      clearScreen: () => false,
      pasteFromClipboard: () => false,
    });
    const press = (init: KeyboardEventInit) => {
      const event = new fake.dom.window.KeyboardEvent('keydown', { cancelable: true, ...init });
      fake.container.dispatchEvent(event);
      return event;
    };
    return { container, sent, feature, press };
  }

  test('adds one container capture keydown listener and nothing on the window', () => {
    const { container } = setup();
    expect(container.added.map(({ target, type, capture }) => ({ target, type, capture }))).toEqual(
      [{ target: 'container', type: 'keydown', capture: true }],
    );
    expect(fake.win.added).toEqual([]);
    expect(fake.term.subscriptions).toEqual([]);
  });

  test('a configured binding on a real keydown reaches the socket, from the context config', () => {
    const { sent, press } = setup();
    const event = press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(sent).toEqual(['K!']);
    expect(fake.term.calls).toEqual(['scrollToBottom']);
  });

  test('a shortcut acts on the context terminal', () => {
    const { press } = setup();
    fake.term.hasSelection = true;
    const event = press({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(event.defaultPrevented).toBe(true);
    press({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, shiftKey: true });
    expect(fake.term.calls).toEqual(['copySelection', 'jumpToPrompt:1']);
  });

  test('dispose removes the listener; twice is a no-op', () => {
    const { container, sent, feature, press } = setup();
    feature.dispose();
    feature.dispose();
    expect(container.active).toEqual([]);
    expect(container.removed).toHaveLength(1);
    press({ key: 'k', code: 'KeyK', ctrlKey: true });
    expect(sent).toEqual([]);
  });
});
