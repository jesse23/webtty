// A minimal Chrome DevTools Protocol driver for the scroll benchmark: attaches to the
// first page target of a Chrome or Chromium already started with
// `--remote-debugging-port`, and offers the few calls the benchmark needs. Every call
// times out, and a closed socket fails what is pending, so a crashed tab never hangs the
// run (service over Bun's global fetch and WebSocket; it never launches a browser, see
// bench.ts for how to start one).

/** A CDP event handler, given the event's params. */
export type CdpHandler = (params: Record<string, unknown>) => void;

/** The driver the benchmark talks to one page through. */
export interface Cdp {
  /** Sends a CDP command and resolves with its result; rejects on an error or timeout. */
  send(method: string, params?: object): Promise<Record<string, unknown>>;
  /** Adds a handler for a CDP event; the returned function removes it. */
  on(method: string, handler: CdpHandler): () => void;
  /** Evaluates `expression` in the page, awaiting a promise, and returns its value. */
  eval<T>(expression: string): Promise<T>;
  /** Navigates the page and waits for its load event, at most CALL_TIMEOUT_MS. */
  navigate(url: string): Promise<void>;
  /** Dispatches one mouse wheel event at (x, y). */
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  /** Types `text` as one insert, like a paste of plain keys. */
  text(text: string): Promise<void>;
  /** Presses and releases one named key. */
  key(name: KeyName): Promise<void>;
  /** Clicks the left mouse button at (x, y), to focus what is there. */
  click(x: number, y: number): Promise<void>;
  /** The page as a PNG, base64. */
  screenshot(): Promise<string>;
  close(): void;
}

/** The keys the benchmark presses, with what CDP needs to send each. */
const KEYS = {
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
} as const;

/** A key `Cdp.key` can press. */
export type KeyName = keyof typeof KEYS;

/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The longest a command or a page load may take before the call fails. */
export const CALL_TIMEOUT_MS = 30_000;

/** `promise`, or a rejection naming `what` once `ms` have passed without it settling. */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no reply in ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  let closed: Error | null = null;
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
  ws.addEventListener('close', () => {
    closed = new Error('the browser closed the CDP connection');
    for (const fail of pending.values()) fail({ error: { message: closed.message } });
    pending.clear();
  });

  const send: Cdp['send'] = (method, params = {}) => {
    if (closed) return Promise.reject(closed);
    const id = ++nextId;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) =>
      pending.set(id, (msg) =>
        msg.error
          ? reject(new Error(`${method}: ${msg.error.message}`))
          : resolve(msg.result ?? {}),
      ),
    );
    ws.send(JSON.stringify({ id, method, params }));
    return withTimeout(reply, CALL_TIMEOUT_MS, method).finally(() => pending.delete(id));
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
      let off = () => {};
      const loaded = new Promise<void>((resolve) => {
        off = on('Page.loadEventFired', () => resolve());
      });
      try {
        await send('Page.navigate', { url });
        await withTimeout(loaded, CALL_TIMEOUT_MS, `loading ${url}`);
      } finally {
        off();
      }
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
      return String(r.data);
    },
    close: () => ws.close(),
  };
}
