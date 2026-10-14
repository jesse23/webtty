/**
 * Wheel input for apps that scroll themselves: what a wheel event sends when the
 * app tracks the mouse (scroll ticks, each encoded by Ghostty's mouse encoder as a
 * press of button 4 or 5, ADR 049) or is on the alternate screen without mouse
 * tracking (arrow keys), and the pacing that spreads it over time. The
 * terminal's `handleWheel` routes events here. (webtty, ADR 017, ADR 040, ADR 045)
 */
import { Glide, linear, type Pace } from './glide';

/** Wheel travel not yet sent to an app, and its direction. */
export interface WheelAccumulator {
  accum: number;
  dir: number;
}

/** Adds `amount` of travel in `deltaY`'s direction; returns the whole units, negative for up. */
function accumulate(acc: WheelAccumulator, deltaY: number, amount: number): number {
  const dir = deltaY < 0 ? -1 : 1;
  // A direction change drops the remainder.
  if (dir !== acc.dir) {
    acc.accum = 0;
    acc.dir = dir;
  }
  acc.accum += amount;
  const whole = Math.trunc(acc.accum);
  acc.accum -= whole;
  return whole === 0 ? 0 : whole * dir;
}

/**
 * Scroll ticks a wheel event sends to an app that tracks the mouse: negative
 * scrolls up (button 4, SGR 64), positive down (5, SGR 65). Pixel deltas (trackpads, and
 * mouse wheels in Chromium/Safari on macOS) count by distance, one tick per cell
 * height, 1:1 with the OS, and `speed` does not apply (Ghostty skips its scroll
 * multiplier for precision scrolls too). Line and page deltas count one tick per
 * event times `speed`; below 1 the remainder accumulates. (webtty: upstream sent
 * arrow keys on the alternate screen and one SGR per event elsewhere, so trackpads
 * scrolled far ahead of the fingers.)
 */
export function wheelTicks(
  acc: WheelAccumulator,
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  speed: number
): number {
  // 0 is WheelEvent.DOM_DELTA_PIXEL.
  return accumulate(acc, e.deltaY, e.deltaMode === 0 ? Math.abs(e.deltaY) / cellHeight : speed);
}

/**
 * Arrow keys a wheel event sends on the alternate screen when the app does not
 * track the mouse: one per line of travel, like scrolling the normal screen's
 * scrollback. Pixel deltas count by cell height, line deltas by line, page deltas
 * by `rows`; the remainder accumulates. Negative is up. (webtty: upstream sent
 * round(deltaY / 33) per event, at most 5, so slow trackpad deltas and Firefox's
 * 3-line notches sent nothing.)
 */
export function wheelArrows(
  acc: WheelAccumulator,
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  rows: number
): number {
  const amount = Math.abs(e.deltaY);
  // 0 is WheelEvent.DOM_DELTA_PIXEL, 1 DOM_DELTA_LINE.
  const lines = e.deltaMode === 0 ? amount / cellHeight : e.deltaMode === 1 ? amount : amount * rows;
  return accumulate(acc, e.deltaY, lines);
}

/**
 * One up (`dir` < 0) or down arrow key. With application cursor keys (DECCKM),
 * which less sets, it is ESC O A/B; less ignores ESC [ A/B then.
 */
export function wheelArrowKey(dir: number, applicationCursor: boolean): string {
  return (applicationCursor ? '\x1bO' : '\x1b[') + (dir < 0 ? 'A' : 'B');
}

/**
 * Sends the scroll ticks of wheel events to an app spread over time instead of
 * in one burst: a TrackPoint sends a delta of up to 20 lines every 30-200 ms, and
 * a wheel notch several lines at once, which an app would otherwise scroll in
 * jumps. The queued ticks follow a `Glide` as each event's `Pace` says, but
 * evenly, a few per frame; a new event's ticks join the ones still queued. The count is rounded up,
 * so the first tick goes out on the next frame and a 1-tick notch is not held
 * back. A direction change drops the queued ticks, as `wheelTicks` drops its
 * remainder.
 */
export class TickPacer {
  /** Progress through the queued ticks: `glide.value` ticks are due, `sent` went out. */
  private readonly glide = new Glide();
  private sent = 0;
  private seq = '';
  private dir = 0;
  private frame = 0;

  constructor(private readonly send: (data: string) => void) {}

  /** Queues `count` ticks of `seq` in direction `dir` (-1 or 1) to send as `pace` says. */
  push(seq: string, dir: number, count: number, pace: Pace): void {
    if (dir !== this.dir) this.cancel();
    this.dir = dir;
    // The latest event's sequence: its cell is where the pointer is now.
    this.seq = seq;
    const target = this.glide.target + count;
    if (pace.duration <= 0 && !pace.omega) {
      this.send(seq.repeat(target - this.sent));
      this.reset();
      return;
    }
    // Evenly, whatever the pace's easing: an app moves in whole lines, so easing
    // would only bunch the ticks.
    this.glide.retarget(target, { ...pace, ease: linear }, performance.now());
    if (!this.frame) this.frame = requestAnimationFrame(this.step);
  }

  /** Drops the queued ticks. */
  cancel(): void {
    this.reset();
    this.dir = 0;
  }

  private reset(): void {
    this.glide.jump(0);
    this.sent = 0;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly step = (now: number): void => {
    this.frame = 0;
    this.glide.step(now, 1e-3);
    const target = this.glide.target;
    const due = Math.min(target, Math.ceil(this.glide.value - 1e-9)) - this.sent;
    if (due > 0) {
      this.send(this.seq.repeat(due));
      this.sent += due;
    }
    if (this.sent < target) {
      this.frame = requestAnimationFrame(this.step);
    } else {
      this.reset();
    }
  };
}
