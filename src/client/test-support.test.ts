// Self-tests for the client's test fakes in test-support/ (ADR 064). They live here, not
// beside the fakes, because nothing under a test-support/ folder may be named *.test.ts.

import { describe, expect, test } from 'bun:test';
import { createDomWindow } from './test-support/dom-window';
import { FAKE_CONFIG, fakeContext } from './test-support/fake-context';
import { fakeResizeObserver } from './test-support/fake-resize-observer';
import { fakeWebSocket } from './test-support/fake-socket';
import { FakeTerminal } from './test-support/fake-terminal';
import { FakeWindow } from './test-support/fake-window';
import { ManualClock } from './test-support/manual-clock';
import { RecordingTarget, recordListeners } from './test-support/recording-target';
import { AT_ONCE } from './vendor/ghostty-web';

describe('ManualClock', () => {
  test('runs timeouts in due order when time advances, with now() at each due time', () => {
    const clock = new ManualClock(100);
    const log: string[] = [];
    clock.setTimeout(() => log.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => log.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => log.push(`c@${clock.now()}`), 20);
    clock.advance(15);
    expect(log).toEqual(['a@110']);
    expect(clock.now()).toBe(115);
    clock.advance(5);
    expect(log).toEqual(['a@110', 'b@120', 'c@120']);
    expect(clock.pending.timers).toBe(0);
  });

  test('a timeout set by a running timer runs in the same advance when it falls due', () => {
    const clock = new ManualClock();
    const log: number[] = [];
    clock.setTimeout(() => clock.setTimeout(() => log.push(clock.now()), 5), 5);
    clock.advance(10);
    expect(log).toEqual([10]);
  });

  test('clearTimeout cancels; unknown ids are ignored', () => {
    const clock = new ManualClock();
    let runs = 0;
    const id = clock.setTimeout(() => runs++);
    clock.clearTimeout(id);
    clock.clearTimeout(999);
    clock.clearTimeout(undefined);
    clock.advance(1);
    expect(runs).toBe(0);
  });

  test('intervals repeat until cleared', () => {
    const clock = new ManualClock();
    const log: number[] = [];
    const id = clock.setInterval(() => log.push(clock.now()), 10);
    clock.advance(35);
    expect(log).toEqual([10, 20, 30]);
    clock.clearInterval(id);
    clock.advance(100);
    expect(log).toEqual([10, 20, 30]);
  });

  test('a zero interval still moves time on, so it cannot loop forever', () => {
    const clock = new ManualClock();
    let runs = 0;
    clock.setInterval(() => runs++, 0);
    clock.advance(3);
    expect(runs).toBe(4);
  });

  test('frame() runs queued callbacks with the frame time; ones queued meanwhile wait', () => {
    const clock = new ManualClock();
    const log: string[] = [];
    clock.requestAnimationFrame((t) => {
      log.push(`first@${t}`);
      clock.requestAnimationFrame((u) => log.push(`next@${u}`));
    });
    const dropped = clock.requestAnimationFrame(() => log.push('dropped'));
    clock.cancelAnimationFrame(dropped);
    clock.frame(16);
    expect(log).toEqual(['first@16']);
    expect(clock.pending.frames).toBe(1);
    clock.frame();
    expect(log).toEqual(['first@16', `next@${16 + 1000 / 60}`]);
  });
});

describe('RecordingTarget', () => {
  const a = () => {};
  const b = () => {};

  test('records adds with their options and removes that match type, listener and capture', () => {
    const target = new RecordingTarget('window');
    target.addEventListener('keydown', a, { capture: true, passive: false });
    target.addEventListener('keydown', a, { capture: true });
    target.addEventListener('keydown', b, { once: true });
    expect(target.added.map((r) => [r.target, r.type, r.capture, r.passive, r.once])).toEqual([
      ['window', 'keydown', true, false, undefined],
      ['window', 'keydown', true, undefined, undefined],
      ['window', 'keydown', false, undefined, true],
    ]);
    // The duplicate add is ignored, as the DOM does.
    expect(target.active).toHaveLength(2);
    target.removeEventListener('keydown', a);
    expect(target.removed).toEqual([]);
    target.removeEventListener('keydown', a, true);
    expect(target.removed).toEqual([target.added[0]]);
    expect(target.active.map((r) => r.listener)).toEqual([b]);
  });

  test('dispatch calls live listeners in order, objects too, and drops once listeners', () => {
    const target = new RecordingTarget();
    const log: string[] = [];
    target.addEventListener('focus', () => log.push('fn'), { once: true });
    target.addEventListener('focus', { handleEvent: (e: Event) => log.push(`object:${e.type}`) });
    target.addEventListener('blur', () => log.push('blur'));
    target.dispatch({ type: 'focus' });
    target.dispatch({ type: 'focus' });
    expect(log).toEqual(['fn', 'object:focus', 'object:focus']);
    expect(target.active.map((r) => r.type)).toEqual(['focus', 'blur']);
  });
});

describe('recordListeners', () => {
  test('logs the adds and removes on a real DOM target, which still runs its listeners', async () => {
    const dom = createDomWindow();
    const element = dom.document.createElement('div');
    const recording = recordListeners(element, 'container');
    const log: string[] = [];
    const listener = () => log.push('focusin');
    element.addEventListener('focusin', listener, { capture: true });
    element.dispatchEvent(new dom.window.Event('focusin'));
    expect(recording.active.map((r) => [r.target, r.type, r.capture])).toEqual([
      ['container', 'focusin', true],
    ]);
    element.removeEventListener('focusin', listener, true);
    element.dispatchEvent(new dom.window.Event('focusin'));
    expect(log).toEqual(['focusin']);
    expect(recording.removed).toHaveLength(1);
    expect(recording.active).toEqual([]);
    // EventTarget takes a null listener and ignores it
    const target: EventTarget = element;
    target.addEventListener('focusin', null);
    target.removeEventListener('focusin', null);
    expect(recording.added).toHaveLength(1);
    await dom.close();
  });
});

describe('fakeWebSocket', () => {
  test('records the sockets made and what the client sends while open', () => {
    const fake = fakeWebSocket();
    expect(() => fake.last()).toThrow();
    new fake.WebSocket('ws://host/ws/main?cols=80');
    const socket = fake.last();
    expect(socket.url).toBe('ws://host/ws/main?cols=80');
    expect(socket.readyState).toBe(fake.WebSocket.CONNECTING);
    expect(() => socket.send('early')).toThrow();
    const log: string[] = [];
    socket.onopen = () => log.push('open');
    socket.onmessage = (e) => log.push(`message:${e.data}`);
    socket.onclose = (e) => log.push(`close:${e.code}`);
    socket.open();
    expect(socket.readyState).toBe(socket.OPEN);
    socket.send('hi');
    socket.receive('out');
    socket.serverClose(4001);
    socket.send('late');
    expect(socket.sent).toEqual(['hi']);
    expect(log).toEqual(['open', 'message:out', 'close:4001']);
  });

  test('a client close and a failure end with a close event', () => {
    const fake = fakeWebSocket();
    new fake.WebSocket('ws://a');
    const closed = fake.last();
    const codes: number[] = [];
    closed.onclose = (e) => codes.push(e.code);
    closed.close(1000, 'bye');
    closed.close();
    expect(closed.closedBy).toEqual({ code: 1000, reason: 'bye' });
    new fake.WebSocket('ws://b');
    const failed = fake.last();
    const events: string[] = [];
    failed.onerror = (e) => events.push(e.type);
    failed.onclose = (e) => events.push(`${e.type}:${e.code}:${e.wasClean}`);
    failed.fail();
    new fake.WebSocket('ws://c');
    const plain = fake.last();
    plain.onclose = (e) => codes.push(e.code);
    plain.close();
    expect(codes).toEqual([1000, 1005]);
    expect(events).toEqual(['error', 'close:1006:false']);
    expect(fake.sockets).toHaveLength(3);
  });
});

describe('FakeTerminal', () => {
  test('logs subscriptions in order and delivers fired events until disposed', () => {
    const term = new FakeTerminal();
    const log: string[] = [];
    const title = term.onTitleChange((t) => log.push(`title:${t}`));
    term.onBell(() => log.push('bell'));
    term.onResize(({ cols, rows }) => log.push(`resize:${cols}x${rows}`));
    expect(term.subscriptions).toEqual(['onTitleChange', 'onBell', 'onResize']);
    term.fire('onTitleChange', 'vim');
    term.fire('onBell');
    title.dispose();
    term.fire('onTitleChange', 'ignored');
    term.resize(100, 30);
    expect(log).toEqual(['title:vim', 'bell', 'resize:100x30']);
    expect([term.cols, term.rows]).toEqual([100, 30]);
  });

  test('records writes and commands', () => {
    const term = new FakeTerminal();
    let written = false;
    term.write('a');
    term.write(new Uint8Array([1]));
    term.write('b', () => {
      written = true;
    });
    expect(written).toBe(true);
    expect(term.output).toBe('ab');
    expect(term.written).toHaveLength(3);
    term.viewportY = 5;
    term.paste('x');
    term.find('needle');
    expect(term.findNext()).toBe(true);
    expect(term.findPrevious()).toBe(true);
    term.endFind();
    term.focus();
    term.reset();
    term.scrollToBottom();
    expect(term.viewportY).toBe(0);
    expect(term.calls).toEqual([
      'paste:x',
      'find:needle',
      'findNext',
      'findPrevious',
      'endFind',
      'focus',
      'reset',
      'scrollToBottom',
    ]);
    expect(term.asTerminal() as object).toBe(term);
  });

  test('loads addons, syncs cell pixels and gets a renderer as open() gives one', () => {
    const term = new FakeTerminal();
    let activatedWith: unknown;
    term.loadAddon({ activate: (t) => (activatedWith = t) });
    term.syncCellPixelSize();
    expect(activatedWith).toBe(term);
    expect(term.renderer).toBeUndefined();
    const renderer = term.attachRenderer();
    expect(term.wasmTerm).toBeDefined();
    renderer.render({}, false, 2);
    renderer.remeasureFont();
    expect(term.calls).toEqual([
      'loadAddon',
      'syncCellPixelSize',
      'render:dirty@2',
      'remeasureFont',
    ]);
  });

  test('records open, clear, focus resync and dispose, and keeps the attached hooks', async () => {
    const term = new FakeTerminal();
    const parent = { id: 'terminal' } as HTMLElement;
    await term.open(parent);
    expect(term.clearScreen()).toBe(true);
    term.clearable = false;
    expect(term.clearScreen()).toBe(false);
    term.resyncFocus();
    term.dispose();
    expect(term.calls).toEqual([
      'open:#terminal',
      'clearScreen',
      'clearScreen',
      'resyncFocus',
      'dispose',
    ]);
    expect(term.hasMouseTracking()).toBe(false);
    const handler = () => true;
    const pace = () => AT_ONCE;
    const hook = () => {};
    term.attachCustomWheelEventHandler(handler);
    term.attachWheelPace(pace);
    term.attachBeforeRender(hook);
    expect([term.wheelHandler, term.wheelPace, term.beforeRender]).toEqual([handler, pace, hook]);
    term.attachCustomWheelEventHandler();
    expect(term.wheelHandler).toBeUndefined();
  });
});

describe('FakeWindow', () => {
  test('records listeners as `window`, media queries, and close and focus calls', () => {
    const win = new FakeWindow('https://example.test:1234/s/abc');
    expect(win.location.host).toBe('example.test:1234');
    expect(win.location.pathname).toBe('/s/abc');
    win.addEventListener('resize', () => {});
    expect(win.added[0].target).toBe('window');
    const query = win.matchMedia('(resolution: 1dppx)');
    expect(query.matches).toBe(true);
    expect(query.name).toBe('media (resolution: 1dppx)');
    expect(win.queries).toEqual([query]);
    win.close();
    win.focus();
    expect(win.calls).toEqual(['close', 'focus']);
    expect(win.asWindow() as object).toBe(win);
  });
});

describe('fakeResizeObserver', () => {
  test('records observers and targets, reports resizes until disconnected', () => {
    const { ResizeObserver, observers } = fakeResizeObserver();
    let resizes = 0;
    const observer = new ResizeObserver(() => resizes++);
    const a = {} as Element;
    const b = {} as Element;
    observer.observe(a, { box: 'border-box' });
    observer.observe(b);
    observer.unobserve(b);
    observer.unobserve(b);
    expect(observers[0].observed).toEqual([{ target: a, options: { box: 'border-box' } }]);
    observers[0].resize();
    observer.disconnect();
    observers[0].resize();
    expect(resizes).toBe(1);
    expect(observers[0].disconnected).toBe(true);
  });
});

describe('fakeContext', () => {
  test('a context over a happy-dom #terminal with settable fonts and visibility', async () => {
    const fake = fakeContext({ padding: 4 });
    expect(fake.ctx.config.padding).toBe(4);
    expect(fake.ctx.config.fontSize).toBe(FAKE_CONFIG.fontSize);
    expect(fake.ctx.doc.getElementById('terminal')).toBe(fake.container);
    expect(fake.ctx.term as object).toBe(fake.term);
    expect(fake.ctx.win as object).toBe(fake.win);
    let changes = 0;
    fake.ctx.doc.addEventListener('visibilitychange', () => changes++);
    fake.setVisibility('hidden');
    expect(fake.ctx.doc.visibilityState).toBe('hidden');
    expect(changes).toBe(1);
    let loaded = false;
    void fake.ctx.doc.fonts.ready.then(() => {
      loaded = true;
    });
    await fake.fontsLoaded();
    expect(loaded).toBe(true);
    await fake.dom.close();
  });
});

describe('createDomWindow', () => {
  test('gives a document of its own, not a global one', async () => {
    const dom = createDomWindow();
    expect(dom.window.location.pathname).toBe('/s/test');
    dom.document.body.appendChild(dom.document.createElement('div'));
    expect(dom.document.querySelectorAll('div')).toHaveLength(1);
    expect((globalThis as { document?: unknown }).document).not.toBe(dom.document);
    await dom.close();
  });
});
