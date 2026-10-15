// A WebSocket stand-in for client tests (test fake, ADR 064): it records what the client
// sends and lets the test play the server, opening, sending output and closing with a
// code. fakeWebSocket() gives a constructor to inject and the sockets it made, in order.

/** The ready states, as numbers, matching `WebSocket.CONNECTING` and its kin. */
export const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 } as const;

/** One client socket: the slice of `WebSocket` webtty's client uses, plus server-side controls. */
export class FakeSocket {
  static readonly CONNECTING = READY_STATE.CONNECTING;
  static readonly OPEN = READY_STATE.OPEN;
  static readonly CLOSING = READY_STATE.CLOSING;
  static readonly CLOSED = READY_STATE.CLOSED;
  readonly CONNECTING = READY_STATE.CONNECTING;
  readonly OPEN = READY_STATE.OPEN;
  readonly CLOSING = READY_STATE.CLOSING;
  readonly CLOSED = READY_STATE.CLOSED;

  readyState: number = READY_STATE.CONNECTING;
  /** Every message the client sent, in order. */
  readonly sent: string[] = [];
  /** The code and reason of the client's own `close()`, once it called it. */
  closedBy?: { code?: number; reason?: string };

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {}

  /**
   * The client sends a message. As in the browser, sending before the socket opens throws
   * and sending after it closed is dropped.
   */
  send(data: string): void {
    if (this.readyState === READY_STATE.CONNECTING) {
      throw new Error('FakeSocket: send before the socket opened');
    }
    if (this.readyState === READY_STATE.OPEN) this.sent.push(data);
  }

  /** The client closes the socket; the close event follows, as it would from the server. */
  close(code?: number, reason?: string): void {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.closedBy = { code, reason };
    this.serverClose(code ?? 1005, reason ?? '');
  }

  /** The server accepts the connection. */
  open(): void {
    this.readyState = READY_STATE.OPEN;
    this.onopen?.({ type: 'open' } as Event);
  }

  /** The server sends `data`. */
  receive(data: string): void {
    this.onmessage?.({ type: 'message', data } as MessageEvent<string>);
  }

  /** The connection fails: an error event, then a close with code 1006. */
  fail(): void {
    this.onerror?.({ type: 'error' } as Event);
    this.serverClose(1006, '');
  }

  /** The server closes the connection with `code`. */
  serverClose(code: number, reason = ''): void {
    this.readyState = READY_STATE.CLOSED;
    this.onclose?.({ type: 'close', code, reason, wasClean: code !== 1006 } as CloseEvent);
  }
}

/** A `WebSocket` constructor for injection, and every socket it has made. */
export interface FakeWebSocket {
  WebSocket: typeof WebSocket;
  sockets: FakeSocket[];
  /** The newest socket; throws when none was made, so a test fails where it expected one. */
  last(): FakeSocket;
}

/** Makes a fresh `WebSocket` stand-in whose sockets the test can reach. */
export function fakeWebSocket(): FakeWebSocket {
  const sockets: FakeSocket[] = [];
  class RecordedSocket extends FakeSocket {
    constructor(url: string | URL) {
      super(String(url));
      sockets.push(this);
    }
  }
  return {
    // The fake covers the members the client uses, not the whole WebSocket interface.
    WebSocket: RecordedSocket as unknown as typeof WebSocket,
    sockets,
    last() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('FakeSocket: no socket was created');
      return socket;
    },
  };
}
