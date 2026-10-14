// A ClientEnv on fakes for the client root's tests (test fake, ADR 064): a FakeTerminal
// from createTerminal, FakeSockets, a ManualClock for the timers and frames, a recording
// FakeWindow, and an injected happy-dom document holding `#terminal`, whose own listeners
// and the container's are recorded too, all into one shared timeline.

import type { ClientEnv } from '../app/browser-env';
import type { ClientConfig } from '../app/client-config';
import type { Ghostty, ITerminalOptions } from '../vendor/ghostty-web';
import { createDomWindow, type DomWindow } from './dom-window';
import { FAKE_CONFIG } from './fake-context';
import { type FakeResizeObserverClass, fakeResizeObserver } from './fake-resize-observer';
import { type FakeWebSocket, fakeWebSocket } from './fake-socket';
import { FakeTerminal } from './fake-terminal';
import { FakeWindow } from './fake-window';
import { ManualClock } from './manual-clock';
import { type ListenerRecord, type RecordingTarget, recordListeners } from './recording-target';

/** What the fake env is built from; each field has a default. */
export interface FakeClientEnvOptions {
  /** The page URL; its path names the session. */
  url?: string;
  config?: Partial<ClientConfig>;
  /** `navigator.platform`; a Mac one turns on Ghostty's macOS keys. */
  platform?: string;
}

/** The env and every fake behind it, for the test to drive and inspect. */
export interface FakeClientEnv {
  env: ClientEnv;
  term: FakeTerminal;
  win: FakeWindow;
  dom: DomWindow;
  container: HTMLElement;
  /** The listeners added to the document and the container. */
  docListeners: RecordingTarget;
  containerListeners: RecordingTarget;
  /** Every listener added to the window, the document and the container, in order. */
  timeline: ListenerRecord[];
  sockets: FakeWebSocket;
  observers: FakeResizeObserverClass;
  clock: ManualClock;
  /** The URLs fetched, the engine URLs loaded and the options each terminal was built with. */
  fetched: string[];
  engines: string[];
  terminalOptions: ITerminalOptions[];
  /** Resolves `document.fonts.ready`. */
  fontsLoaded(): Promise<void>;
}

/** Builds a ClientEnv on fakes; close `dom` in the test's teardown. */
export function fakeClientEnv(options: FakeClientEnvOptions = {}): FakeClientEnv {
  const url = options.url ?? 'http://localhost/s/work';
  const dom = createDomWindow(url);
  const { document } = dom;
  const container = document.createElement('div');
  container.id = 'terminal';
  document.body.append(container);
  let loaded: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });

  const timeline: ListenerRecord[] = [];
  const win = new FakeWindow(url);
  const docListeners = recordListeners(document, 'document');
  const containerListeners = recordListeners(container, 'container');
  for (const target of [win, docListeners, containerListeners]) target.timeline = timeline;

  const term = new FakeTerminal();
  const sockets = fakeWebSocket();
  const observers = fakeResizeObserver();
  const clock = new ManualClock();
  const fetched: string[] = [];
  const engines: string[] = [];
  const terminalOptions: ITerminalOptions[] = [];
  const config = { ...FAKE_CONFIG, ...options.config };
  const navigator = { platform: options.platform ?? 'Linux x86_64' } as Navigator;

  const env: ClientEnv = {
    window: win.asWindow(),
    document,
    navigator,
    fetch: async (input) => {
      fetched.push(input);
      return Response.json(config);
    },
    WebSocket: sockets.WebSocket,
    ResizeObserver: observers.ResizeObserver,
    Notification: undefined,
    performance: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    loadEngine: async (engineUrl) => {
      engines.push(engineUrl);
      // The fake terminal never reaches the engine; the options only carry it.
      return {} as Ghostty;
    },
    createTerminal: (terminal) => {
      terminalOptions.push(terminal);
      return term.asTerminal();
    },
  };
  return {
    env,
    term,
    win,
    dom,
    container,
    docListeners,
    containerListeners,
    timeline,
    sockets,
    observers,
    clock,
    fetched,
    engines,
    terminalOptions,
    fontsLoaded: async () => {
      loaded();
      await ready;
    },
  };
}
