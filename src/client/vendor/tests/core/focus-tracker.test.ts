import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { ManualClock } from '../../../test-support/manual-clock';
import {
  type ListenerRecord,
  RecordingTarget,
  recordListeners,
} from '../../../test-support/recording-target';
import { type FocusEnv, FocusTracker } from '../../ghostty-web/core/focus-tracker';
import { loadGhostty } from '../support/wasm';

// Mode 1004 focus reports, encoded by Ghostty and sent as Ghostty's Surface sends them: on a
// focus change while the mode is on, and the current state when the mode is set (ADR 053);
// and focus kept off the container. A happy-dom container and textarea, a recording window
// and document, a real engine.

/** A document stand-in whose visibility, window focus and active element a test sets. */
class FakePage extends RecordingTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  activeElement: Element | null = null;
  focused = true;

  hasFocus(): boolean {
    return this.focused;
  }
}

let dom: DomWindow | undefined;

afterEach(async () => {
  await dom?.close();
  dom = undefined;
});

/** A tracker attached to a container holding a textarea; `sent` collects its reports. */
/** A host over `container` alone, no engine. */
function hostOf(container: HTMLElement | undefined) {
  return {
    element: () => container,
    textarea: () => undefined,
    engine: () => undefined,
    disableStdin: () => false,
    send: () => {},
  };
}

/** A host with nothing open. */
const noHost = () => hostOf(undefined);

async function tracked(options: { disableStdin?: boolean } = {}) {
  dom = createDomWindow();
  const { document, window } = dom;
  const container = document.createElement('div');
  const textarea = document.createElement('textarea');
  container.appendChild(textarea);
  document.body.appendChild(container);
  const containerLog = recordListeners(container, 'container');
  const page = new FakePage('document');
  const win = new RecordingTarget('window');
  const env: FocusEnv = { window: win, document: page };
  // One log for the three targets, in the order the listeners are added
  const timeline: ListenerRecord[] = [];
  for (const target of [containerLog, page, win]) target.timeline = timeline;
  const engine = (await loadGhostty()).createTerminal(20, 2);
  const sent: string[] = [];
  let element: HTMLElement | undefined = container;
  const tracker = new FocusTracker({
    element: () => element,
    textarea: () => textarea,
    engine: () => engine,
    disableStdin: () => options.disableStdin ?? false,
    send: (data) => sent.push(data),
  });
  tracker.attach(container, env);
  const focusEvent = (type: string, relatedTarget: EventTarget | null = null) =>
    new window.FocusEvent(type, { relatedTarget });
  return {
    tracker,
    engine,
    sent,
    container,
    textarea,
    page,
    win,
    containerLog,
    timeline,
    write: (data: string) => {
      engine.write(data);
      tracker.followMode();
    },
    focusIn: () => container.dispatchEvent(focusEvent('focusin')),
    focusOut: (to: EventTarget | null = null) =>
      container.dispatchEvent(focusEvent('focusout', to)),
    windowBlur: () => win.dispatch({ type: 'blur' }),
    windowFocus: () => win.dispatch({ type: 'focus' }),
    visibility: () => page.dispatch({ type: 'visibilitychange' }),
    detachElement: () => {
      element = undefined;
    },
  };
}

describe('FocusTracker listeners', () => {
  test('adds the container, window and document listeners in open() order', async () => {
    const { timeline, engine } = await tracked();
    expect(timeline.map((r) => `${r.target} ${r.type}`)).toEqual([
      'container focusin',
      'window focus',
      'container focusin',
      'container focusout',
      'window blur',
      'document visibilitychange',
    ]);
    engine.free();
  });

  test('dispose removes every listener with its capture flag, once (ADR 065)', async () => {
    const { tracker, containerLog, win, page, engine } = await tracked();
    tracker.dispose();
    tracker.dispose();
    for (const target of [containerLog, win, page]) {
      expect(target.active).toEqual([]);
      // The store removes them newest first
      expect([...target.removed].reverse()).toEqual(target.added);
    }
    engine.free();
  });

  test('dispose before attach does nothing', () => {
    expect(() => new FocusTracker(noHost()).dispose()).not.toThrow();
  });
});

describe('FocusTracker focusContainer', () => {
  test('focuses the container now and once more after a timeout', async () => {
    const { tracker, engine, container } = await tracked();
    const clock = new ManualClock();
    const refocusing = new FocusTracker(hostOf(container), clock);
    refocusing.attach(container, { window: new RecordingTarget(), document: new FakePage() });
    let focuses = 0;
    container.focus = () => void focuses++;
    refocusing.focusContainer();
    expect([focuses, clock.pending.timers]).toEqual([1, 1]);
    clock.advance(0);
    expect([focuses, clock.pending.timers]).toEqual([2, 0]);
    // The timeout that ran is forgotten, so dispose() has nothing more to cancel
    refocusing.dispose();
    tracker.dispose();
    engine.free();
  });

  test('dispose() cancels a refocus not yet run', async () => {
    const { container } = await tracked();
    const clock = new ManualClock();
    const tracker = new FocusTracker(hostOf(container), clock);
    tracker.attach(container, { window: new RecordingTarget(), document: new FakePage() });
    let focuses = 0;
    container.focus = () => void focuses++;
    tracker.focusContainer();
    tracker.dispose();
    clock.advance(10);
    expect([focuses, clock.pending.timers]).toEqual([1, 0]);
  });

  test('does nothing before attach or without a container', () => {
    const clock = new ManualClock();
    new FocusTracker(noHost(), clock).focusContainer();
    expect(clock.pending.timers).toBe(0);
  });
});

describe('FocusTracker keeps focus off the container', () => {
  test('focus landing on the container goes to the textarea', async () => {
    const { container, textarea, engine } = await tracked();
    container.tabIndex = 0;
    container.focus();
    expect(container.ownerDocument.activeElement).toBe(textarea);
    engine.free();
  });

  test('a window coming back with the container active focuses the textarea', async () => {
    const { container, textarea, page, windowFocus, detachElement, engine } = await tracked();
    let focused = 0;
    textarea.focus = () => {
      focused++;
    };
    page.activeElement = textarea;
    windowFocus();
    expect(focused).toBe(0);
    page.activeElement = container;
    windowFocus();
    expect(focused).toBe(1);
    // With no container, as after dispose(), a window focus moves nothing
    detachElement();
    windowFocus();
    expect(focused).toBe(1);
    engine.free();
  });
});

describe('FocusTracker mode 1004 reports', () => {
  test('sends nothing on focus changes while mode 1004 is off', async () => {
    const { sent, focusIn, focusOut, engine } = await tracked();
    focusIn();
    focusOut();
    expect(sent).toEqual([]);
    engine.free();
  });

  test('sends the current focus when the app sets the mode, then each change', async () => {
    const { sent, write, focusIn, focusOut, engine } = await tracked();
    focusIn();
    write('\x1b[?1004h');
    expect(sent).toEqual(['\x1b[I']);
    focusOut();
    focusIn();
    expect(sent).toEqual(['\x1b[I', '\x1b[O', '\x1b[I']);
    // Setting it again while it is on, or other output, sends nothing.
    write('\x1b[?1004hplain');
    expect(sent).toHaveLength(3);
    write('\x1b[?1004l');
    focusOut();
    expect(sent).toHaveLength(3);
    // Set again while unfocused: the report says so.
    write('\x1b[?1004h');
    expect(sent).toEqual(['\x1b[I', '\x1b[O', '\x1b[I', '\x1b[O']);
    engine.free();
  });

  test('a move inside the terminal, or a repeated event, is not a change', async () => {
    const { sent, write, focusIn, focusOut, textarea, engine } = await tracked();
    focusIn();
    write('\x1b[?1004h');
    // The container passing focus on to the textarea: out with an inside target, in.
    focusOut(textarea);
    focusIn();
    focusIn();
    expect(sent).toEqual(['\x1b[I']);
    focusOut();
    focusOut();
    expect(sent).toEqual(['\x1b[I', '\x1b[O']);
    engine.free();
  });

  test('a window blur, or a tab hidden and shown with no blur (Chrome), is a change', async () => {
    const { sent, write, focusIn, windowBlur, visibility, page, textarea, engine } =
      await tracked();
    page.activeElement = textarea;
    focusIn();
    write('\x1b[?1004h');
    windowBlur();
    focusIn();
    page.visibilityState = 'hidden';
    visibility();
    page.visibilityState = 'visible';
    visibility();
    expect(sent).toEqual(['\x1b[I', '\x1b[O', '\x1b[I', '\x1b[O', '\x1b[I']);
    // Shown with focus elsewhere in the page, or in another window: still unfocused.
    page.visibilityState = 'hidden';
    visibility();
    page.activeElement = null;
    page.visibilityState = 'visible';
    visibility();
    page.activeElement = textarea;
    page.focused = false;
    visibility();
    expect(sent).toHaveLength(6);
    engine.free();
  });

  test('resync sends the current focus while the mode is on, for a new connection', async () => {
    const { tracker, sent, write, focusIn, focusOut, engine } = await tracked();
    focusIn();
    tracker.resync();
    expect(sent).toEqual([]);
    write('\x1b[?1004h');
    // The socket goes down: this report is dropped on the way to the app.
    focusOut();
    sent.length = 0;
    // The replay of a reconnect leaves the mode on, which sends nothing: the resync does.
    write('\x1b[?1004h');
    expect(sent).toEqual([]);
    tracker.resync();
    expect(sent).toEqual(['\x1b[O']);
    engine.free();
  });

  test('a new engine starts with the mode off: setting it reports again', async () => {
    const { tracker, sent, write, focusIn, engine } = await tracked();
    focusIn();
    write('\x1b[?1004h');
    tracker.reset();
    write('\x1b[?1004h');
    expect(sent).toEqual(['\x1b[I', '\x1b[I']);
    engine.free();
  });

  test('sends nothing with stdin disabled', async () => {
    const { sent, write, focusIn, focusOut, engine } = await tracked({ disableStdin: true });
    write('\x1b[?1004h');
    focusIn();
    focusOut();
    expect(sent).toEqual([]);
    engine.free();
  });
});
