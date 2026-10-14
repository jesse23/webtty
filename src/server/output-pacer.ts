// PTY output flow control (ADR 048, ADR 062): each client acknowledges the characters it has
// parsed; the server stops sending to a client that is too far behind, queues its output in
// order, and pauses the PTY while every client is behind. An object, one per session.

/** Close code for a client whose queued output passed {@link FlowLimits.maxPending}. */
export const FELL_BEHIND = 4003;

/** Limits in characters (UTF-16 code units, `string.length`), except `legacyBuffered`. */
export interface FlowLimits {
  /** Unacknowledged characters at which a client is blocked and output is queued. */
  highWater: number;
  /** Unacknowledged characters at which a blocked client is unblocked. */
  lowWater: number;
  /** Largest message the queue is coalesced into (whole chunks are never split). */
  chunk: number;
  /** Queued characters past which the client is closed with {@link FELL_BEHIND}. */
  maxPending: number;
  /**
   * `bufferedAmount` (bytes) past which a legacy client is closed with {@link FELL_BEHIND}.
   * Under Bun the close frame is stuck behind the native backlog and the client sees 1006.
   */
  legacyBuffered: number;
}

/** How long {@link OutputPacer.end} waits for an acknowledgement before it closes anyway, in ms. */
export const END_FLUSH_MS = 2000;

/** The limits every session uses; tests pass smaller ones to reach each threshold quickly. */
export const DEFAULT_FLOW_LIMITS: FlowLimits = {
  highWater: 2 * 1024 * 1024,
  lowWater: 512 * 1024,
  chunk: 64 * 1024,
  maxPending: 16 * 1024 * 1024,
  legacyBuffered: 8 * 1024 * 1024,
};

/** The part of a WebSocket the pacer uses. */
export interface FlowSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** A PTY that may be able to stop reading output (node-pty can, `Bun.Terminal` cannot). */
export interface PausablePty {
  pause?(): void;
  resume?(): void;
}

interface ClientFlow {
  /** Whether the client acknowledges (connected with `?flow=1`). */
  acks: boolean;
  sent: number;
  acked: number;
  blocked: boolean;
  pending: string[];
  pendingLength: number;
  /** Queued characters past which the client is closed: the limit plus what {@link OutputPacer.send} queued. */
  maxPending: number;
  /** Set by {@link OutputPacer.end}: the client is closed with `code` once its queue is sent. */
  ending: { code: number; reason: string; wait: () => void; done: () => void } | null;
}

/** Splits `data` into pieces of at most `size` characters without cutting a surrogate pair. */
export function splitChunks(data: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(i + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(data.slice(i, end));
    i = end;
  }
  return pieces;
}

/** Paces one session's output to its clients. */
export class OutputPacer {
  private flows = new Map<FlowSocket, ClientFlow>();
  private paused = false;

  /**
   * @param pty - Returns the session's PTY, or `null` before it spawns.
   * @param limits - Flow limits (tests pass small ones).
   */
  constructor(
    private pty: () => PausablePty | null,
    private limits: FlowLimits = DEFAULT_FLOW_LIMITS,
  ) {}

  /** Whether the PTY is paused because every client is behind. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** Starts pacing `ws`. `acks` is true for a client that sends acknowledgements. */
  add(ws: FlowSocket, acks: boolean): void {
    this.flows.set(ws, {
      acks,
      sent: 0,
      acked: 0,
      blocked: false,
      pending: [],
      pendingLength: 0,
      maxPending: this.limits.maxPending,
      ending: null,
    });
    this.updatePause();
  }

  /** Stops pacing `ws` (closed) and drops its queue. */
  remove(ws: FlowSocket): void {
    const flow = this.flows.get(ws);
    if (!flow) return;
    this.flows.delete(ws);
    flow.ending?.done();
    this.updatePause();
  }

  /**
   * Closes every client with `code` once the output queued for it has been sent, as
   * its acknowledgements allow, so the tail of the output is not lost when the shell
   * exits. A client that does not acknowledge for `ms` is closed anyway; the queue
   * no longer grows, so a client that keeps acknowledging is closed within
   * {@link FlowLimits.maxPending}.
   *
   * @returns A promise that resolves once every client is closed.
   */
  end(code: number, reason: string, ms = END_FLUSH_MS): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const [ws, flow] of this.flows) {
      if (flow.pending.length === 0) {
        this.close(ws, code, reason);
        continue;
      }
      waits.push(
        new Promise((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          flow.ending = {
            code,
            reason,
            wait: () => {
              clearTimeout(timer);
              timer = setTimeout(() => this.close(ws, code, reason), ms);
            },
            done: () => {
              clearTimeout(timer);
              resolve();
            },
          };
          flow.ending.wait();
        }),
      );
    }
    return Promise.all(waits).then(() => {});
  }

  /**
   * Sends `data` (the banner or the scrollback replay) to one client, in order after
   * anything queued for it. An acknowledging client gets it in pieces of
   * {@link FlowLimits.chunk}, so a large replay is paced like live output instead of
   * filling the send buffer at once. What it queues is allowed on top of
   * {@link FlowLimits.maxPending} until the queue drains: the replay is already held as the
   * scrollback, and a scrollback over the limit would otherwise close every client that
   * connects. A legacy
   * client gets it whole as before: Bun's shim accepts one large message, but drops and
   * reorders pieces sent past its 16 MB backlog.
   */
  send(ws: FlowSocket, data: string): void {
    const flow = this.flows.get(ws);
    if (flow?.acks) {
      const queued = flow.pendingLength;
      for (const piece of splitChunks(data, this.limits.chunk)) this.write(ws, flow, piece, false);
      flow.maxPending += flow.pendingLength - queued;
    } else if (flow) {
      this.write(ws, flow, data);
    }
    this.updatePause();
  }

  /** Sends `data` to every client. */
  broadcast(data: string): void {
    for (const [ws, flow] of this.flows) this.write(ws, flow, data);
    this.updatePause();
  }

  /** Records that `ws` has parsed `total` characters since it connected. */
  ack(ws: FlowSocket, total: number): void {
    const flow = this.flows.get(ws);
    if (!flow?.acks || !Number.isFinite(total)) return;
    flow.acked = Math.max(flow.acked, Math.min(total, flow.sent));
    if (flow.blocked && flow.sent - flow.acked <= this.limits.lowWater) {
      flow.blocked = false;
      this.flush(ws, flow);
    }
    if (flow.ending && flow.pending.length === 0) {
      this.close(ws, flow.ending.code, flow.ending.reason);
      return;
    }
    flow.ending?.wait();
    this.updatePause();
  }

  /** Sends or queues `data`; `bounded` is false for a queue allowed past `maxPending`. */
  private write(ws: FlowSocket, flow: ClientFlow, data: string, bounded = true): void {
    if (ws.readyState !== ws.OPEN) return;
    if (!flow.acks) {
      ws.send(data);
      if (ws.bufferedAmount > this.limits.legacyBuffered) this.fellBehind(ws);
      return;
    }
    if (!flow.blocked && flow.pending.length === 0) {
      this.transmit(ws, flow, data);
      return;
    }
    flow.pending.push(data);
    flow.pendingLength += data.length;
    if (bounded && flow.pendingLength > flow.maxPending) this.fellBehind(ws);
  }

  private transmit(ws: FlowSocket, flow: ClientFlow, data: string): void {
    ws.send(data);
    flow.sent += data.length;
    if (flow.sent - flow.acked >= this.limits.highWater) flow.blocked = true;
  }

  /** Sends the queue in order, coalesced, until it is empty or the client blocks again. */
  private flush(ws: FlowSocket, flow: ClientFlow): void {
    let i = 0;
    while (i < flow.pending.length && !flow.blocked && ws.readyState === ws.OPEN) {
      let message = flow.pending[i++];
      while (
        i < flow.pending.length &&
        message.length + flow.pending[i].length <= this.limits.chunk
      ) {
        message += flow.pending[i++];
      }
      flow.pendingLength -= message.length;
      this.transmit(ws, flow, message);
    }
    flow.pending.splice(0, i);
    // A drained queue holds no replay any more, so live output gets the plain limit.
    if (flow.pending.length === 0) flow.maxPending = this.limits.maxPending;
  }

  private fellBehind(ws: FlowSocket): void {
    this.flows.delete(ws);
    ws.close(FELL_BEHIND, 'fell behind');
  }

  private close(ws: FlowSocket, code: number, reason: string): void {
    const flow = this.flows.get(ws);
    this.flows.delete(ws);
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
    flow?.ending?.done();
    this.updatePause();
  }

  private updatePause(): void {
    let allBlocked = this.flows.size > 0;
    for (const flow of this.flows.values()) {
      if (!flow.acks || !flow.blocked) {
        allBlocked = false;
        break;
      }
    }
    const pty = this.pty();
    if (allBlocked && !this.paused && pty?.pause) {
      pty.pause();
      this.paused = true;
    } else if (!allBlocked && this.paused) {
      pty?.resume?.();
      this.paused = false;
    }
  }
}
