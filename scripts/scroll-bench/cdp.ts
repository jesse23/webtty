// A minimal Chrome DevTools Protocol driver for the scroll benchmark: attaches to the
// first page target of a Chrome or Chromium already started with
// `--remote-debugging-port`, and offers the few calls the benchmark needs (service over
// Bun's global fetch and WebSocket; it never launches a browser, see bench.ts for how
// to start one).

/** A CDP event handler, given the event's params. */
export type CdpHandler = (params: Record<string, unknown>) => void;

/** The driver the benchmark talks to one page through. */
export interface Cdp {
  /** Sends a CDP command and resolves with its result; rejects on a protocol error. */
  send(method: string, params?: object): Promise<Record<string, unknown>>;
  /** Adds a handler for a CDP event; the returned function removes it. */
  on(method: string, handler: CdpHandler): () => void;
  /** Evaluates `expression` in the page, awaiting a promise, and returns its value. */
  eval<T>(expression: string): Promise<T>;
  /** Navigates the page and waits for its load event. */
  navigate(url: string): Promise<void>;
  /** Dispatches one mouse wheel event at (x, y). */
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  /** Types `text` as one insert, like a paste of plain keys. */
  text(text: string): Promise<void>;
  /** Presses and releases one named key. */
  key(name: KeyName): Promise<void>;
  /** Clicks the left mouse button at (x, y), to focus what is there. */
  click(x: number, y: number): Promise<void>;
  /** A PNG screenshot of the page. */
  screenshot(): Promise<Uint8Array>;
  close(): void;
}

/** The keys the benchmark presses, with what CDP needs to send each. */
const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27, text: '\u001b' },
} as const;

/** A key `Cdp.key` can press. */
export type KeyName = keyof typeof KEYS;

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Target {
  type: string;
  webSocketDebuggerUrl: string;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/** Connects to the first page target of the browser listening on `port`. */
export async function connectCdp(port: number): Promise<Cdp> {
  const listing = await fetch(`http://127.0.0.1:${port}/json`).catch(() => {
    throw new Error(`no browser on CDP port ${port}; start Chrome with --remote-debugging-port`);
  });
  const page = ((await listing.json()) as Target[]).find((t) => t.type === 'page');
  if (!page) throw new Error(`no page target on CDP port ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map<number, (msg: Message) => void>();
  const handlers = new Map<string, Set<CdpHandler>>();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data)) as Message;
    if (msg.method) for (const h of handlers.get(msg.method) ?? []) h(msg.params ?? {});
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });

  const send: Cdp['send'] = (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      pending.set(id, (msg) =>
        msg.error
          ? reject(new Error(`${method}: ${msg.error.message}`))
          : resolve(msg.result ?? {}),
      ),
    );
  };
  const on: Cdp['on'] = (method, handler) => {
    const set = handlers.get(method) ?? new Set();
    handlers.set(method, set.add(handler));
    return () => set.delete(handler);
  };
  const mouse = (type: string, x: number, y: number) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });

  await send('Page.enable');
  return {
    send,
    on,
    async eval<T>(expression: string) {
      const r = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails)}`);
      return (r.result as { value: T }).value;
    },
    async navigate(url) {
      const loaded = new Promise<void>((resolve) => {
        const off = on('Page.loadEventFired', () => {
          off();
          resolve();
        });
      });
      await send('Page.navigate', { url });
      await loaded;
    },
    async wheel(x, y, deltaY) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    },
    async text(text) {
      await send('Input.insertText', { text });
    },
    async key(name) {
      const { text, ...rest } = KEYS[name];
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, text, ...rest });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, ...rest });
    },
    async click(x, y) {
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
    },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(String(r.data), 'base64');
    },
    close: () => ws.close(),
  };
}
