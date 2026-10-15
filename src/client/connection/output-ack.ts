// Sends ack messages as output is parsed, so the server paces a slow tab (object,
// ADR 048). One instance per socket, bound to that socket's send and open check.

/** Characters of parsed output between acknowledgements (ADR 048). */
export const ACK_EVERY = 64 * 1024;
/** How long after the last output a smaller count is acknowledged, in ms. */
export const ACK_IDLE_MS = 100;

/** The idle timer's clock, the page's timers by default; the client root passes its env's. */
export interface AckTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const windowTimers: AckTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Acknowledges parsed PTY output so the server can pace it (ADR 048). Call
 * {@link OutputAck.parsed} after each output message has been written to the
 * terminal; it sends `{"type":"ack","chars":<total>}`, the characters parsed since
 * the connection opened, every {@link ACK_EVERY} characters and
 * {@link ACK_IDLE_MS} after output stops. One instance per connection.
 */
export class OutputAck {
  private total = 0;
  private reported = 0;
  private timer: unknown = null;

  constructor(
    private send: (message: string) => void,
    private timers: AckTimers = windowTimers,
  ) {}

  /** Records that `chars` more characters of output have been parsed. */
  parsed(chars: number): void {
    this.total += chars;
    if (this.total - this.reported >= ACK_EVERY) {
      this.flush();
    } else if (this.timer === null && this.total > this.reported) {
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.flush();
      }, ACK_IDLE_MS);
    }
  }

  /** Stops the idle timer, for a connection that has closed. */
  dispose(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private flush(): void {
    this.dispose();
    if (this.total === this.reported) return;
    this.reported = this.total;
    this.send(JSON.stringify({ type: 'ack', chars: this.total }));
  }
}
