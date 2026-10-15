// A real DOM for view and feature tests (test adapter, ADR 064): one happy-dom Window per
// test, whose document and window are injected into the code under test. It is never
// registered on globalThis, so tests that stub globals and the wasm tests see no change.

import { Window as HappyWindow } from 'happy-dom';

/** One test's DOM, typed as the browser's own, and the call that closes it. */
export interface DomWindow {
  /** Typed as the browser's global `window`, so tests reach its constructors (`window.KeyboardEvent`). */
  window: Window & typeof globalThis;
  document: Document;
  /** Aborts happy-dom's pending tasks and closes the window; call it in the test's teardown. */
  close(): Promise<void>;
}

/** Opens a fresh happy-dom window at `url`; nothing is fetched, the URL only sets `location`. */
export function createDomWindow(url = 'http://localhost/s/test'): DomWindow {
  const happy = new HappyWindow({ url, width: 1024, height: 768 });
  // happy-dom implements the DOM interfaces the code under test uses; lib.dom's types
  // name the full browser API, so the window is typed as the browser's here, once.
  const window = happy as unknown as Window & typeof globalThis;
  return {
    window,
    document: window.document,
    close: () => happy.happyDOM.close(),
  };
}
