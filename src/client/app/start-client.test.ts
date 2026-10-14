import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeClientEnv, fakeClientEnv } from '../test-support/fake-client-env';
import type { ListenerRecord } from '../test-support/recording-target';
import type { Disposable } from '../vendor/ghostty-web';
import { screenClearer, startClient } from './start-client';

let fake: FakeClientEnv;
let client: Disposable | undefined;

afterEach(async () => {
  client?.dispose();
  client = undefined;
  await fake.dom.close();
});

async function start(options: Parameters<typeof fakeClientEnv>[0] = {}): Promise<FakeClientEnv> {
  fake = fakeClientEnv(options);
  client = await startClient(fake.env);
  return fake;
}

const key = (r: ListenerRecord): string => `${r.target}${r.capture ? ' capture' : ''} ${r.type}`;

/**
 * Every app listener the root adds, in the order it adds them, with the step that adds it
 * (the SPEC's 13 steps; the find bar's own listeners are on its own elements).
 */
const INSTALL_ORDER: [owner: string, listener: string][] = [
  ['composer', 'container compositionstart'],
  ['composer', 'container compositionupdate'],
  ['composer', 'container compositionend'],
  ['composer', 'container focusout'],
  ['layout', 'window resize'],
  ['repaint on visible', 'document visibilitychange'],
  ['kitty overlay', 'document visibilitychange'],
  ['clipboard arming', 'window capture keydown'],
  ['clipboard arming', 'window capture mousedown'],
  ['clipboard arming', 'window capture paste'],
  ['clipboard arming', 'window capture drop'],
  ['tab title attended', 'container focusin'],
  ['tab title attended', 'window capture keydown'],
  ['notifier user input', 'window capture keydown'],
  ['notifier user input', 'window capture mousedown'],
  ['notifier attended', 'container focusin'],
  ['title and notifier attended', 'document visibilitychange'],
  ['notifier attended', 'window capture keydown'],
  ['key dispatcher', 'container capture keydown'],
  ['font zoom', 'window capture keydown'],
  ['paste', 'container capture paste'],
];

/** The SPEC's per-target listener table ("The client composition root"). */
const SPEC_TABLE: Record<string, string[]> = {
  'window capture keydown': [
    'clipboard arming',
    'tab title attended',
    'notifier user input',
    'notifier attended',
    'font zoom',
  ],
  'window capture mousedown': ['clipboard arming', 'notifier user input'],
  'container focusin': ['tab title attended', 'notifier attended'],
  'container capture keydown': ['key dispatcher'],
  'document visibilitychange': [
    'repaint on visible',
    'kitty overlay',
    'title and notifier attended',
  ],
};

describe('startClient', () => {
  test('bootstraps the session, config, engine and terminal in #terminal', async () => {
    await start({ config: { theme: { background: '#101010', padding: '#202020' } } });
    expect(fake.fetched).toEqual(['/api/config']);
    expect(fake.engines).toEqual(['/ghostty-vt-small.wasm']);
    expect(fake.terminalOptions[0]?.theme).toEqual({ background: '#101010' });
    expect(fake.term.calls[0]).toBe('open:#terminal');
    expect(fake.container.style.background).toBe('#202020');
    expect(fake.dom.document.title).toBe('work | webtty');
    expect(fake.sockets.last().url).toBe('ws://localhost/ws/work/pty?cols=80&rows=24&flow=1');
  });

  test('a page outside /s/ is the main session', async () => {
    await start({ url: 'http://localhost/' });
    expect(fake.sockets.last().url).toContain('/ws/main/pty');
  });

  test('adds the listeners in the documented order, as the SPEC table lists per target', async () => {
    await start();
    expect(fake.timeline.map(key)).toEqual(INSTALL_ORDER.map(([, listener]) => listener));
    for (const [target, owners] of Object.entries(SPEC_TABLE)) {
      const inOrder = INSTALL_ORDER.filter(([, l]) => l === target).map(([owner]) => owner);
      expect(inOrder).toEqual(owners);
    }
    // The DPR watch listens on its media query, once.
    expect(fake.win.queries.map((q) => q.active.map((r) => r.type))).toEqual([['change']]);
  });

  test('subscribes to the terminal emitters in the documented order', async () => {
    await start();
    expect(fake.term.subscriptions).toEqual([
      // 2. smooth scroll follows the terminal's own moves and resizes
      'onScroll',
      'onResize',
      // 4. clipboard, 5. tab title, 6. notifications
      'onClipboardWrite',
      'onTitleChange',
      'onBell',
      'onDesktopNotification',
      // 9. find, 12. input and size, 13. paste
      'onFindChange',
      'onData',
      'onResize',
      'onPasteRequest',
    ]);
  });

  test('on open: the size goes out, then the focus state is resynced', async () => {
    await start();
    const socket = fake.sockets.last();
    const sentAtResync: string[][] = [];
    fake.term.resyncFocus = () => {
      sentAtResync.push([...socket.sent]);
    };
    socket.open();
    expect(sentAtResync).toEqual([[JSON.stringify({ type: 'resize', cols: 80, rows: 24 })]]);
  });

  test('output is written through the graphics, then acknowledged after the parse', async () => {
    await start();
    const socket = fake.sockets.last();
    socket.open();
    const sentAtWrite: number[] = [];
    const write = fake.term.write.bind(fake.term);
    fake.term.write = (data, callback) => {
      sentAtWrite.push(socket.sent.length);
      write(data, callback);
    };
    // A graphics command is taken out of the text the terminal sees.
    socket.receive('a\x1b_Ga=d\x1b\\b');
    expect(fake.term.output).toBe('ab');
    expect(socket.sent).toHaveLength(1);
    // The idle ack runs on the env's clock, 100 ms after the output stops.
    fake.clock.advance(100);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'ack', chars: 10 }));
    // A full ack window is acknowledged at once, after it was written.
    socket.receive('x'.repeat(64 * 1024));
    // Two writes for the text either side of the command, then one before the second ack.
    expect(sentAtWrite).toEqual([1, 1, 2]);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: 'ack', chars: 10 + 64 * 1024 }));
  });

  test('typed input and grid resizes go to the open socket', async () => {
    await start();
    const socket = fake.sockets.last();
    socket.open();
    fake.term.fire('onData', 'ls\r');
    fake.term.resize(100, 30);
    expect(socket.sent.slice(1)).toEqual([
      'ls\r',
      JSON.stringify({ type: 'resize', cols: 100, rows: 30 }),
    ]);
  });

  test('a lost socket reconnects on the env clock', async () => {
    await start();
    fake.sockets.last().open();
    fake.sockets.last().serverClose(1006);
    expect(fake.term.output).toContain('Connection lost. Reconnecting in 2s...');
    fake.clock.advance(2000);
    expect(fake.sockets.sockets).toHaveLength(2);
  });

  test('Cmd+K on a Mac reaches the clear through the key dispatcher', async () => {
    await start({ platform: 'MacIntel' });
    const { KeyboardEvent } = fake.dom.window;
    fake.container.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', metaKey: true, bubbles: true }),
    );
    expect(fake.term.calls).toContain('clearScreen');
  });

  test('the scroll hooks are attached; font zoom fits at once', async () => {
    await start();
    expect(fake.term.wheelHandler).toBeDefined();
    expect(fake.term.wheelPace).toBeDefined();
    expect(fake.term.beforeRender).toBeDefined();
    const { KeyboardEvent } = fake.dom.window;
    fake.win.dispatch(new KeyboardEvent('keydown', { key: '=', code: 'Equal', ctrlKey: true }));
    expect(fake.term.options.fontSize).toBe(15);
  });

  test('dispose removes every listener, view and hook, and closes the socket; twice is a no-op', async () => {
    await start();
    const socket = fake.sockets.last();
    socket.open();
    const body = fake.dom.document.body;
    expect(body.children.length).toBeGreaterThan(1);
    client?.dispose();
    client?.dispose();
    expect(fake.win.active).toEqual([]);
    expect(fake.docListeners.active).toEqual([]);
    expect(fake.containerListeners.active).toEqual([]);
    expect(fake.win.queries.flatMap((q) => q.active)).toEqual([]);
    expect(fake.observers.observers.every((o) => o.disconnected)).toBe(true);
    expect(socket.closedBy).toBeDefined();
    expect(fake.term.wheelHandler).toBeUndefined();
    expect(fake.term.calls.at(-1)).toBe('dispose');
    expect([...body.children].map((el) => el.id)).toEqual(['terminal']);
    expect(fake.container.children).toHaveLength(0);
    expect(fake.clock.pending).toEqual({ timers: 0, frames: 0 });
  });
});

describe('screenClearer', () => {
  function parts(clears: boolean) {
    const log: string[] = [];
    const clear = screenClearer(
      {
        clearScreen: () => {
          log.push('term.clearScreen');
          return clears;
        },
      },
      { clear: () => log.push('graphics.clear') },
      { onOutput: () => log.push('smoothScroll.onOutput') },
    );
    return { log, clear };
  }

  test('clears the screen, then the placements, then the sub-line offset', () => {
    const { log, clear } = parts(true);
    expect(clear()).toBe(true);
    expect(log).toEqual(['term.clearScreen', 'graphics.clear', 'smoothScroll.onOutput']);
  });

  test('does nothing more when the terminal does not clear (the alternate screen)', () => {
    const { log, clear } = parts(false);
    expect(clear()).toBe(false);
    expect(log).toEqual(['term.clearScreen']);
  });
});
