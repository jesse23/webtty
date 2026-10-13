/**
 * A value that moves toward a target a frame at a time: the one motion behind
 * scrolling's glides, for the scrollback position (smooth-scroll.ts) and for the
 * scroll ticks paced to apps (wheel.ts). (webtty, ADR 045)
 */

/** One frame at 60 Hz. */
export const FRAME_MS = 1000 / 60;

/**
 * A spring's stiffness doubles once its target has not moved for this long: the
 * input has stopped, so the value should stop soon rather than coast, while a
 * running stream keeps the softer, steadier spring.
 */
export const SPRING_RELEASE_MS = 60;

export type Ease = (t: number) => number;

export const linear: Ease = (t) => t;

export const easeOutCubic: Ease = (t) => 1 - (1 - t) ** 3;

/**
 * How a glide reaches a new target: over `duration` ms with `ease` (linear when
 * absent), at once when `duration` is 0, or, with `omega`, following a critically
 * damped spring of that stiffness (rad/s).
 */
export interface Pace {
  duration: number;
  ease?: Ease;
  omega?: number;
}

/** Reach the target at once. */
export const AT_ONCE: Pace = { duration: 0 };

/**
 * Advances a critically damped spring at `x` with velocity `v` (per second)
 * toward a fixed `target` by `dt` seconds. Exact for a fixed target, so it is
 * stable at any frame time, and it never overshoots a target it approaches from
 * rest. Returns the new position and velocity.
 */
export function springStep(
  x: number,
  v: number,
  target: number,
  omega: number,
  dt: number
): [number, number] {
  const e = x - target;
  const k = Math.exp(-omega * dt);
  const c = v + omega * e;
  return [target + (e + c * dt) * k, (v - omega * c * dt) * k];
}

/** The stiffness of a spring with stiffness `omega` `idle` ms after its target last moved. */
export function springOmega(omega: number, idle: number): number {
  return idle > SPRING_RELEASE_MS ? omega * 2 : omega;
}

/**
 * A value gliding toward a target. `retarget` sets where it is heading and how;
 * `step`, called once per frame with the frame's timestamp, moves it.
 *
 * - A timed glide starts from the glide's latest frame, or a frame before the
 *   call when none is running: a frame's timestamp precedes the events handled in
 *   it, so a glide starting at the event would not move on its next frame, and a
 *   stream of retargets would stall every other frame.
 * - A spring takes over at the current velocity, so the speed does not jump.
 * - The velocity is kept across retargets for that reason.
 */
export class Glide {
  /** Where the value is, and where it is heading. */
  value = 0;
  target = 0;
  /** Per second. */
  private velocity = 0;
  private from = 0;
  private start = 0;
  private duration = 0;
  private ease: Ease = linear;
  /** The spring's stiffness while following one, else 0. */
  private omega = 0;
  private lastFrame: number | null = null;
  private lastRetarget = 0;
  private moving = false;

  /** Whether the value is still moving toward the target. */
  get active(): boolean {
    return this.moving;
  }

  /** Heads for `target` as `pace` says; at once when its duration is 0. `now` is `performance.now()`. */
  retarget(target: number, pace: Pace, now: number): void {
    this.lastRetarget = now;
    if (pace.omega) {
      if (!this.moving) this.lastFrame = now - FRAME_MS;
      this.omega = pace.omega;
      this.target = target;
      this.moving = true;
    } else if (pace.duration <= 0) {
      this.jump(target);
    } else {
      this.omega = 0;
      this.from = this.value;
      this.target = target;
      this.start = this.lastFrame ?? now - FRAME_MS;
      this.duration = pace.duration;
      this.ease = pace.ease ?? linear;
      this.moving = true;
    }
  }

  /** Puts the value at `value` and stops. */
  jump(value: number): void {
    this.value = value;
    this.target = value;
    this.stop();
  }

  /** Stops where the value is. */
  stop(): void {
    this.moving = false;
    this.omega = 0;
    this.velocity = 0;
    this.lastFrame = null;
  }

  /**
   * Moves the value for the frame at `now`. A spring has arrived once within
   * `settle` of the target and moving less than that per frame.
   */
  step(now: number, settle: number): void {
    if (!this.moving) return;
    const before = this.value;
    const dt = Math.min(Math.max(now - (this.lastFrame ?? now - FRAME_MS), 0), 50) / 1000;
    let done: boolean;
    if (this.omega) {
      const omega = springOmega(this.omega, now - this.lastRetarget);
      const [x, v] = springStep(this.value, this.velocity, this.target, omega, dt);
      this.velocity = v;
      done = Math.abs(this.target - x) < settle && Math.abs(v) * (FRAME_MS / 1000) < settle;
      this.value = x;
    } else {
      // A frame's timestamp can precede the glide's start by part of a frame.
      const t = Math.min(1, Math.max(0, (now - this.start) / this.duration));
      this.value = this.from + (this.target - this.from) * this.ease(t);
      if (dt > 0) this.velocity = (this.value - before) / dt;
      done = t >= 1;
    }
    if (done) {
      this.jump(this.target);
    } else {
      this.lastFrame = now;
    }
  }
}
