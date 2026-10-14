// A scriptable stand-in for a `ws` WebSocket: records what is sent and how it closed in a
// shared log, and lets a test emit `message`, `close` and `error`. A test-support object for
// the session and socket handler tests (ADR 064).

type Listener = (...args: never[]) => void;

/** The `ws` OPEN ready state, the one a FakeSocket starts in. */
export const OPEN = 1;
/** The `ws` CLOSED ready state, which close() moves the socket to. */
export const CLOSED = 3;

/** A socket with the surface the session, the pacer and the ws handlers use, and no network. */
export class FakeSocket {
  readyState = OPEN;
  readonly OPEN = OPEN;
  bufferedAmount = 0;
  /** Every message sent, in order. */
  readonly sent: string[] = [];
  /** How the socket was last closed, or `null` while open. */
  closed: { code?: number; reason?: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  /**
   * @param log - Shared event log; entries read `<name>.send <first 20 chars>` and `<name>.close <code>`.
   * @param name - The name used in the log.
   */
  constructor(
    readonly log: string[] = [],
    readonly name = 'ws',
  ) {}

  send(data: string): void {
    this.sent.push(data);
    this.log.push(`${this.name}.send ${JSON.stringify(data.slice(0, 20))}`);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = CLOSED;
    this.log.push(`${this.name}.close ${code ?? ''}`.trimEnd());
  }

  on(event: 'message', listener: (data: Buffer) => void): this;
  on(event: 'close' | 'error', listener: (err?: Error) => void): this;
  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  /** The number of listeners registered for `event`. */
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** Calls the listeners for `event` with `args`, as `ws` would. */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
  }

  /** Delivers a text frame from the client, as a Buffer like `ws` does. */
  receive(text: string): void {
    this.emit('message', Buffer.from(text, 'utf8'));
  }
}
