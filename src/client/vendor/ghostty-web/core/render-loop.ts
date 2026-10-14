// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The render loop (controller): one animation frame after another while the terminal is
// open, each running beforeRender, a find step, the render, the replies that arose outside
// a write and the textarea anchoring, in that order (ADR 042, ADR 045, ADR 055, ADR 061).

import type { FrameScheduler, RenderLoopHost } from './host-types';

/** The browser's animation frames, read when called. */
export const browserFrames: FrameScheduler = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (id) => cancelAnimationFrame(id),
};

/** The browser's monotonic clock, read when called. */
const performanceNow = (): number => performance.now();

/**
 * Runs a frame at once on start() and then one per animation frame until cancelled or the
 * host is no longer live. A frame allocates nothing: the frame callback is made once.
 */
export class RenderLoop {
  private frameId?: number;

  /** `now` stands in for the frame time of the first, synchronous frame. */
  constructor(
    private readonly host: RenderLoopHost,
    private readonly frames: FrameScheduler = browserFrames,
    private readonly now: () => number = performanceNow,
  ) {}

  /** Runs a frame now and keeps the loop going; does nothing while it already runs. */
  start(): void {
    if (this.frameId) return;
    this.frame();
  }

  /**
   * Stops the loop. Terminal.resize() stops it while the engine reallocates its buffers
   * and starts it again after, rather than skipping frames on a flag cleared by an
   * animation frame, which background tabs throttle.
   */
  cancel(): void {
    if (this.frameId) {
      this.frames.cancelAnimationFrame(this.frameId);
      this.frameId = undefined;
    }
  }

  // Hot path: every frame. The order is fixed (ADR 061).
  private readonly frame = (now?: number): void => {
    const host = this.host;
    if (!host.live()) return;
    host.beforeRender(now ?? this.now());
    host.stepFind(now ?? this.now());
    // Render with the engine's dirty tracking: it updates the render state once,
    // redraws only dirty rows and clears the dirty flags at the end
    host.render();
    // Replies that arose outside write() reach the PTY within a frame (webtty, ADR 042)
    if (host.hasReplies()) host.drainReplies();
    // Keep the input textarea on the cursor cell (webtty)
    host.anchorTextarea();
    this.frameId = this.frames.requestAnimationFrame(this.frame);
  };
}
