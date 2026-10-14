// A ClientContext on fakes for feature tests (test fake, ADR 064): a FakeTerminal, a
// recording FakeWindow and an injected happy-dom document holding `#terminal`. The
// document's `fonts.ready` and `visibilityState`, which happy-dom lacks or fixes, are set
// by the test.

import type { ClientConfig } from '../app/client-config';
import type { ClientContext } from '../app/client-context';
import { createDomWindow, type DomWindow } from './dom-window';
import { FakeTerminal } from './fake-terminal';
import { FakeWindow } from './fake-window';

/** The context and the fakes behind it, for the test to drive. */
export interface FakeContext {
  ctx: ClientContext;
  term: FakeTerminal;
  win: FakeWindow;
  dom: DomWindow;
  container: HTMLElement;
  /** Resolves `document.fonts.ready`, as the browser does once the web fonts load. */
  fontsLoaded(): Promise<void>;
  /** Sets `document.visibilityState` and dispatches `visibilitychange`. */
  setVisibility(state: DocumentVisibilityState): void;
}

/** The config a feature sees when the test does not say otherwise. */
export const FAKE_CONFIG: ClientConfig = {
  cols: 80,
  rows: 24,
  fontSize: 14,
  fontFamily: 'monospace',
  cursorStyle: 'block',
  cursorStyleBlink: false,
  scrollbackLines: 1000,
  theme: {},
  copyOnSelect: false,
  rightClickBehavior: 'contextMenu',
  clipboardWrite: true,
  bellTitle: true,
  desktopNotifications: true,
  mouseScrollSpeed: 1,
  padding: 0,
  keyboardBindings: [],
};

/** Builds a context on fakes; close `dom` in the test's teardown. */
export function fakeContext(config: Partial<ClientConfig> = {}): FakeContext {
  const dom = createDomWindow();
  const { document } = dom;
  const container = document.createElement('div');
  container.id = 'terminal';
  document.body.append(container);
  let loaded: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });
  let visibility: DocumentVisibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    get: () => visibility,
    configurable: true,
  });
  const term = new FakeTerminal();
  const win = new FakeWindow();
  const ctx: ClientContext = {
    term: term.asTerminal(),
    container,
    config: { ...FAKE_CONFIG, ...config },
    terminalTheme: {},
    mac: false,
    doc: document,
    win: win.asWindow(),
  };
  return {
    ctx,
    term,
    win,
    dom,
    container,
    fontsLoaded: async () => {
      loaded();
      await ready;
    },
    setVisibility: (state) => {
      visibility = state;
      document.dispatchEvent(new dom.window.Event('visibilitychange'));
    },
  };
}
