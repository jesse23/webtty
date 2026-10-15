// webtty (ADR 067), not from upstream.
// The hold on painting while the app updates the screen in a synchronized update (object):
// DEC mode 2026, which libghostty-vt tracks and Ghostty's renderer honours. An app that
// redraws the whole screen (pi on each wheel tick) sends it as one update, and the browser
// can paint between the WebSocket messages it arrives in; holding until the update ends
// keeps those half-drawn frames off the screen. The policy is Ghostty's (termio/Thread.zig
// `sync_reset_ms`, Termio.zig `resetSynchronizedOutput`): every begin restarts a 1 s
// timer, and when it runs out the mode is turned off, so an app that never ends an update
// cannot freeze the view, and DECRQM, the echo and the next update all see it off. And, as
// Ghostty's renderer wakes when an update ends, an update that ends after a held frame is
// painted at its end, before the next one begins: an app that sends updates back to back
// would otherwise be caught inside one on every frame.

import type { SyncHoldHost } from './host-types';
import { lastSyncEnd, scanSyncBegin, scanSyncBeginBytes } from './sync-scan';

/** Synchronized output: the app brackets an update with `CSI ? 2026 h` and `CSI ? 2026 l`. */
export const SYNCHRONIZED_OUTPUT_MODE = 2026;

/** How long after its last begin an update may hold painting: Ghostty's `sync_reset_ms`. */
export const SYNC_HOLD_MAX_MS = 1000;

/** Whether painting waits for the app's synchronized update to end. */
export class SyncHold {
  /** When the current update last began, or null outside one. */
  private since: number | null = null;
  /** The unfinished mode sequence the last write ended in. */
  private carry = '';
  /** A frame was held since the last paint: the next update to end paints at its end. */
  private waiting = false;

  /** `now` is the clock a write is timed on; a frame passes its own timestamp. */
  constructor(
    private readonly host: SyncHoldHost,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Output was written to the engine: a begin in it, even one inside an update already
   * running, restarts the update's time, as each `CSI ? 2026 h` restarts Ghostty's timer.
   */
  wrote(data: string | Uint8Array): void {
    const carry = this.carry;
    const scan =
      typeof data === 'string' ? scanSyncBegin(data, carry) : scanSyncBeginBytes(data, carry);
    this.carry = scan.carry;
    if (scan.begun) this.since = this.now();
    else if (!this.host.active()) this.since = null;
  }

  /**
   * The render loop's step, once a frame at `now`: an update past SYNC_HOLD_MAX_MS since
   * its last begin is ended, turning the mode off in the engine. Only the loop calls this, so
   * asking `held` never changes the engine.
   */
  expire(now: number): void {
    if (!this.host.active()) {
      this.since = null;
      return;
    }
    // An update begun in a form the scan does not read (a C1 CSI) is timed from its first frame
    this.since ??= now;
    if (now - this.since < SYNC_HOLD_MAX_MS) return;
    this.host.end();
    this.since = null;
  }

  /**
   * Whether painting at `now` holds: inside an update that began under SYNC_HOLD_MAX_MS
   * ago, or one the render loop has not timed yet. A read: an update past its time is
   * ended by the loop's `expire`.
   */
  held(now: number = this.now()): boolean {
    return this.host.active() && (this.since === null || now - this.since < SYNC_HOLD_MAX_MS);
  }

  /** The render loop held a frame's paint. */
  frameHeld(): void {
    this.waiting = true;
  }

  /** The terminal painted: nothing waits for an update's end. */
  painted(): void {
    this.waiting = false;
  }

  /**
   * Where to paint in output about to be written: just past the last update that ends in
   * it, while a held frame waits for one; -1 to write it whole and paint on a frame.
   */
  paintPoint(data: string | Uint8Array): number {
    return this.waiting ? lastSyncEnd(data, this.carry) : -1;
  }

  /** Forgets the update and any unfinished sequence: the engine was replaced. */
  reset(): void {
    this.since = null;
    this.carry = '';
    this.waiting = false;
  }
}
