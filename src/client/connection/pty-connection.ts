// The tab's WebSocket to its session's PTY (service, ADR 048, ADR 060): the URL,
// connect and reconnect by the close policy, and one open guard for everything the tab
// sends. The WebSocket constructor and the timers are injected, so tests run it on fakes.

import { closeActionFor } from './close-policy';
import { OutputAck } from './output-ack';
import type { OutputHandler } from './output-pipeline';
import { statusLine } from './status-line';

/** The terminal's grid size, sent in the URL and on open. */
export interface GridSize {
  cols: number;
  rows: number;
}

/** What the connection needs from the tab around it. */
export interface PtyConnectionHost {
  /** The terminal's current grid size. */
  size(): GridSize;
  /**
   * Runs synchronously when a socket is created, before any of its messages: the output
   * starts with the session's replay (ADR 052, ADR 053, ADR 056).
   */
  created(): void;
  /** Runs on open, before the size is sent: kitty graphics state starts over (ADR 032). */
  opening(): void;
  /**
   * Runs on open, after the size is sent: focus changes while the socket was down were
   * dropped, so the app's mode 1004 gets the current state (ADR 053).
   */
  opened(): void;
  /** Handles one output message with the ack of the socket it came on. */
  output: OutputHandler;
  /** Writes bytes to the terminal: the status lines. */
  write(data: string): void;
  /** Resets the terminal, before the replay that follows a fell-behind close (ADR 048). */
  reset(): void;
  /** Closes the tab, after the session or the server is gone. */
  closeWindow(): void;
}

/** The browser objects the connection uses, each the page's own in production. */
export interface PtyConnectionDeps {
  WebSocket: typeof WebSocket;
  location: Pick<Location, 'protocol' | 'host'>;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Makes the ack for one socket, bound to that socket's guarded send (ADR 048). */
  createAck?(send: (message: string) => void): OutputAck;
}

/**
 * One tab's connection to `/ws/<session>/pty`. A new socket replaces the old one on
 * every reconnect; {@link send} and {@link sendResize} go to the current socket only
 * while it is open, and are dropped otherwise, as they always were.
 */
export class PtyConnection {
  private socket: WebSocket | null = null;
  private ack: OutputAck | null = null;
  private timer: number | null = null;
  private disposed = false;
  private readonly createAck: (send: (message: string) => void) => OutputAck;

  constructor(
    private readonly sessionId: string,
    private readonly host: PtyConnectionHost,
    private readonly deps: PtyConnectionDeps,
  ) {
    this.createAck = deps.createAck ?? ((send) => new OutputAck(send));
  }

  /** The socket URL for the current size. flow=1: this client acknowledges output (ADR 048). */
  url(): string {
    const { protocol, host } = this.deps.location;
    const { cols, rows } = this.host.size();
    const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${host}/ws/${this.sessionId}/pty?cols=${cols}&rows=${rows}&flow=1`;
  }

  /** Whether the current socket is open, so a send now would reach the PTY. */
  isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === this.deps.WebSocket.OPEN;
  }

  /** Sends input to the PTY; dropped while the socket is not open. */
  send(data: string): void {
    if (this.isOpen()) this.socket?.send(data);
  }

  /** Tells the server the terminal's new size; dropped while the socket is not open. */
  sendResize(cols: number, rows: number): void {
    this.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /** Opens a new socket, which becomes the current one. */
  connect(): void {
    if (this.disposed) return;
    const socket = new this.deps.WebSocket(this.url());
    this.socket = socket;
    this.host.created();
    // This socket's own ack, sending only on it (ADR 048)
    const ack = this.createAck((message) => {
      if (socket.readyState === this.deps.WebSocket.OPEN) socket.send(message);
    });
    this.ack = ack;
    const { host } = this;

    socket.onopen = () => {
      host.opening();
      const { cols, rows } = host.size();
      this.sendResize(cols, rows);
      host.opened();
    };
    socket.onmessage = (event: MessageEvent<string>) => host.output(event.data, ack);
    socket.onclose = (event: CloseEvent) => {
      // Before any reconnect, so an ack queued for this socket never reaches the next
      ack.dispose();
      this.closed(event.code);
    };
    socket.onerror = () => host.write(statusLine('WebSocket error.'));
  }

  /** Stops reconnecting and closes the current socket without acting on its close. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.ack?.dispose();
    const socket = this.socket;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    this.socket = null;
  }

  private closed(code: number): void {
    const action = closeActionFor(code);
    if (action.kind === 'replay') {
      this.host.reset();
      this.host.write(statusLine(action.message));
      this.connect();
      return;
    }
    this.host.write(statusLine(action.message));
    const next = action.kind === 'retry' ? () => this.connect() : () => this.host.closeWindow();
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      next();
    }, action.delayMs);
  }
}
