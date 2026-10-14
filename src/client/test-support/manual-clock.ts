// A hand-driven clock for tests (test fake, ADR 064): timeouts, intervals and animation
// frames run only when the test advances time or steps a frame, so timing-dependent code
// is tested without waiting. Its methods are bound, so they can be injected as deps.

interface Timer {
  id: number;
  due: number;
  run: () => void;
  /** Set for an interval: how far `due` moves after each run. */
  every?: number;
}

/** Stands in for `setTimeout`, `setInterval`, `requestAnimationFrame` and `performance.now`. */
export class ManualClock {
  private time: number;
  private nextId = 1;
  private timers: Timer[] = [];
  private frames = new Map<number, FrameRequestCallback>();

  constructor(start = 0) {
    this.time = start;
  }

  /** The current time in ms, as `performance.now()` would report it. */
  readonly now = (): number => this.time;

  /** Schedules `run` to run once `ms` have passed. */
  readonly setTimeout = (run: () => void, ms = 0): number => this.schedule(run, ms);

  /** Schedules `run` every `ms`, first after `ms`. */
  readonly setInterval = (run: () => void, ms = 0): number =>
    this.schedule(run, ms, Math.max(1, ms));

  /** Cancels a timeout; unknown ids are ignored, as the browser does. */
  readonly clearTimeout = (id: number | undefined): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  };

  /** Cancels an interval. */
  readonly clearInterval = (id: number | undefined): void => this.clearTimeout(id);

  /** Queues `callback` for the next `frame()`. */
  readonly requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };

  /** Drops a queued frame callback. */
  readonly cancelAnimationFrame = (id: number): void => {
    this.frames.delete(id);
  };

  /** Timers and frame callbacks still waiting. */
  get pending(): { timers: number; frames: number } {
    return { timers: this.timers.length, frames: this.frames.size };
  }

  /**
   * Moves time forward by `ms`, running every timer that falls due on the way in due
   * order (ties in the order they were set), each with `now()` at its due time.
   */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const timer = this.earliestDueBy(end);
      if (!timer) break;
      this.time = timer.due;
      if (timer.every === undefined) this.clearTimeout(timer.id);
      else timer.due += timer.every;
      timer.run();
    }
    this.time = end;
  }

  /**
   * Runs the frame callbacks queued so far with `now()` as their timestamp, after moving
   * time on by `ms` (a frame at 60 Hz by default). Callbacks queued while the frame runs
   * wait for the next one, as in the browser.
   */
  frame(ms = 1000 / 60): void {
    this.advance(ms);
    const queued = [...this.frames];
    this.frames.clear();
    for (const [, callback] of queued) callback(this.time);
  }

  private schedule(run: () => void, ms: number, every?: number): number {
    const id = this.nextId++;
    this.timers.push({ id, due: this.time + Math.max(0, ms), run, every });
    return id;
  }

  private earliestDueBy(end: number): Timer | undefined {
    let earliest: Timer | undefined;
    for (const timer of this.timers) {
      if (timer.due <= end && (!earliest || timer.due < earliest.due)) earliest = timer;
    }
    return earliest;
  }
}
