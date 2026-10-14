// Every browser global the client root touches, behind one interface, with the page's
// own as the production value (adapter, ADR 060, ADR 064). A test passes fakes, or a
// happy-dom window, so the whole root runs without a browser.

import {
  Ghostty,
  type ITerminalOptions,
  type ListenerTarget,
  Terminal,
} from '../vendor/ghostty-web';

/** The window as the root uses it: its URL, pixel ratio, close and focus, and its listeners. */
export interface ClientWindow
  extends Pick<Window, 'location' | 'devicePixelRatio' | 'matchMedia' | 'close' | 'focus'>,
    ListenerTarget {}

/** The globals the client root reads, each one the browser's own in production. */
export interface ClientEnv {
  window: ClientWindow;
  /** The page's document, including `fonts.ready` (ADR 031). */
  document: Document;
  navigator: Navigator;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  WebSocket: typeof WebSocket;
  ResizeObserver: typeof ResizeObserver;
  /** Undefined where the page has no Notification API (http, iOS Safari; ADR 056). */
  Notification: typeof Notification | undefined;
  performance: Pick<Performance, 'now'>;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  /** Loads libghostty-vt from the URL the server serves it at (ADR 041, ADR 047). */
  loadEngine(url: string): Promise<Ghostty>;
  /** Builds the vendored terminal; a test returns a fake. */
  createTerminal(options: ITerminalOptions): Terminal;
}

/**
 * The real globals of `win`, the page's window by default. Functions are wrapped so they
 * are called on `win`, as the browser requires of `fetch` and the timers.
 */
export function browserEnv(win: Window & typeof globalThis = window): ClientEnv {
  return {
    window: win,
    document: win.document,
    navigator: win.navigator,
    fetch: (input, init) => win.fetch(input, init),
    WebSocket: win.WebSocket,
    ResizeObserver: win.ResizeObserver,
    Notification: typeof win.Notification === 'undefined' ? undefined : win.Notification,
    performance: win.performance,
    setTimeout: (handler, ms) => win.setTimeout(handler, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    requestAnimationFrame: (callback) => win.requestAnimationFrame(callback),
    cancelAnimationFrame: (id) => win.cancelAnimationFrame(id),
    loadEngine: (url) => Ghostty.load(url),
    createTerminal: (options) => new Terminal(options),
  };
}
