/**
 * How a wheel event should move: tells a mouse wheel, a trackpad and a sparse
 * stream such as a TrackPoint's apart, and picks the `Pace` that the scrollback
 * glide (smooth-scroll.ts) and the ticks paced to apps (TickPacer) follow. See
 * ADR 045.
 *
 * - A wheel notch eases out over the wheel glide time, or, soon after one in the
 *   same direction, continues linearly over its gap plus a frame, so a spinning
 *   wheel does not pulse.
 * - A sparse delta, 25 ms or more after the previous one (from the second such gap
 *   in a row), glides linearly over that gap plus a frame, so a stream scrolls at the speed it is sent at; the
 *   extra frame keeps the glide going when the next delta is a little late. A
 *   stream stays sparse until two short gaps in a row, so one delta that comes a
 *   little early does not snap or flush.
 * - While a sparse stream's deltas come every 60 ms or faster on average, it
 *   follows a spring instead, which evens out its uneven gaps, until it pauses or
 *   reverses.
 * - Trackpad deltas, a frame apart, move at once.
 */
import { AT_ONCE, easeOutCubic, FRAME_MS, linear, type Pace } from './vendor/ghostty-web';

/** How long a mouse wheel notch glides to its target: VS Code's `smoothScrollDuration`. */
export const WHEEL_GLIDE_MS = 125;

/**
 * A pixel delta this long after the previous one is part of a sparse stream: a
 * TrackPoint sends one every 30-200 ms, a trackpad one per frame.
 */
export const SPARSE_GAP_MS = 25;

/**
 * A wheel notch this soon after one in the same direction continues the scroll at
 * a steady speed instead of easing out, so a spinning wheel or a slow TrackPoint
 * (4 px every 150 ms) does not pulse.
 */
export const STREAM_MS = 200;

/**
 * A sparse stream whose deltas come this often or faster on average (a TrackPoint
 * pushed hard, every 30-45 ms) follows a spring instead of gliding linearly over
 * each gap: its gaps vary, and gliding over each one swung the speed by half
 * from frame to frame.
 */
export const FAST_STREAM_MS = 60;

/** The spring's stiffness, rad/s: about 70 ms to settle, smoothing over a few deltas. */
export const STREAM_OMEGA = 28;

/**
 * Tells a physical mouse wheel from a trackpad by its recent pixel deltas.
 * Adapted from VS Code's `MouseWheelClassifier` (scrollableElement.ts),
 * Copyright (c) Microsoft Corporation, MIT License.
 */
export class WheelClassifier {
  private static readonly CAPACITY = 5;
  /** Scores of the latest events, newest last: 0 looks like a wheel, 1 like a trackpad. */
  private scores: number[] = [];
  private previous: { deltaX: number; deltaY: number } | null = null;

  accept(deltaX: number, deltaY: number): void {
    this.scores.push(this.score(deltaX, deltaY));
    if (this.scores.length > WheelClassifier.CAPACITY) this.scores.shift();
    this.previous = { deltaX, deltaY };
  }

  /** The newest score weighs 1/2, the next 1/4, and so on; the oldest takes the rest. */
  isPhysicalMouseWheel(): boolean {
    if (this.scores.length === 0) return false;
    let remaining = 1;
    let total = 0;
    for (let i = this.scores.length - 1; i >= 0; i--) {
      const influence = i === 0 ? remaining : 2 ** -(this.scores.length - i);
      remaining -= influence;
      total += this.scores[i] * influence;
    }
    return total <= 0.5;
  }

  private score(deltaX: number, deltaY: number): number {
    // Both axes at once: a trackpad.
    if (deltaX !== 0 && deltaY !== 0) return 1;
    let score = 0.5;
    if (!isAlmostInt(deltaX) || !isAlmostInt(deltaY)) score += 0.25;
    // A wheel's notches are multiples of each other; a trackpad accelerates smoothly.
    const prev = this.previous;
    if (prev) {
      const [ax, ay] = [Math.abs(deltaX), Math.abs(deltaY)];
      const [px, py] = [Math.abs(prev.deltaX), Math.abs(prev.deltaY)];
      const minX = Math.max(Math.min(ax, px), 1);
      const minY = Math.max(Math.min(ay, py), 1);
      if (Math.max(ax, px) % minX === 0 && Math.max(ay, py) % minY === 0) score -= 0.5;
    }
    return Math.min(Math.max(score, 0), 1);
  }
}

function isAlmostInt(value: number): boolean {
  return Math.abs(Math.round(value) - value) < 0.01 + Number.EPSILON * 100;
}

/** The OS asks for less motion. */
function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

/** A classified event: its pace, and whether it is a wheel notch. */
interface Classified {
  pace: Pace;
  wheel: boolean;
}

/**
 * The stream of wheel events. Each event is classified once, however many
 * times it is asked about, as the classification tracks the stream (gaps,
 * direction, recent deltas).
 */
export class WheelStream {
  private readonly classifier = new WheelClassifier();
  /** `timeStamp` and direction of the previous event. */
  private lastWheel: number | null = null;
  private lastDir = 0;
  /** In a sparse stream, how many long and short gaps in a row there have been, and its average gap. */
  private sparse = false;
  private longGaps = 0;
  private shortGaps = 0;
  private averageGap = 0;
  /** Following the spring: until the stream pauses, every delta keeps doing so. */
  private springing = false;
  private last: { event: WheelEvent; classified: Classified } | null = null;

  /** How `e` moves the scrollback. With reduced motion, everything moves at once. */
  forScrollback(e: WheelEvent): Pace {
    const { pace } = this.classify(e);
    return reducedMotion() ? AT_ONCE : pace;
  }

  /**
   * How `e`'s ticks to an app are paced. With reduced motion a wheel notch's go at
   * once, but a sparse stream's stay paced: that times input, it does not animate,
   * and sending them at once brought back bursts of 20 ticks every other frame.
   */
  forApp(e: WheelEvent): Pace {
    const { pace, wheel } = this.classify(e);
    return wheel && reducedMotion() ? AT_ONCE : pace;
  }

  private classify(e: WheelEvent): Classified {
    if (this.last?.event !== e) this.last = { event: e, classified: this.next(e) };
    return this.last.classified;
  }

  private next(e: WheelEvent): Classified {
    const gap = this.lastWheel === null ? 0 : e.timeStamp - this.lastWheel;
    // The very first event comes after a pause too.
    const long = this.lastWheel === null || gap >= SPARSE_GAP_MS;
    this.lastWheel = e.timeStamp;
    const dir = Math.sign(e.deltaY);
    const sameDir = dir === this.lastDir;
    this.lastDir = dir;
    if (e.deltaMode === 0) this.classifier.accept(e.deltaX || 0, e.deltaY);
    const wheel = e.deltaMode !== 0 || this.classifier.isPhysicalMouseWheel();
    // A stream turns sparse on its second long gap in a row, as it stops being sparse on
    // its second short one: the first long gap is the pause before any gesture, and
    // gliding a trackpad's first deltas put the view behind the fingers at every start.
    if (long) {
      this.shortGaps = 0;
      if ((++this.longGaps >= 2 || this.sparse) && gap > 0) {
        // A stream's first gap is the pause before it; count it as the slowest gap.
        const capped = Math.min(gap, WHEEL_GLIDE_MS);
        this.averageGap = this.sparse ? 0.4 * capped + 0.6 * this.averageGap : WHEEL_GLIDE_MS;
        this.sparse = true;
      }
    } else {
      this.longGaps = 0;
      if (this.sparse && ++this.shortGaps >= 2) this.sparse = false;
    }
    const spring: Pace = { duration: WHEEL_GLIDE_MS, omega: STREAM_OMEGA };
    // A fast stream stays on the spring until it pauses: leaving it on a short gap
    // applied all the spring's pending distance at once (985 px in one frame), and
    // leaving it as the gaps grew at the end of a push sped up, then stopped hard.
    if (!wheel && this.springing && gap < WHEEL_GLIDE_MS && sameDir) return { pace: spring, wheel };
    this.springing = false;
    if (wheel && gap > 0 && gap <= STREAM_MS && sameDir) {
      return { pace: { duration: Math.min(gap + FRAME_MS, STREAM_MS), ease: linear }, wheel };
    }
    if (wheel) return { pace: { duration: WHEEL_GLIDE_MS, ease: easeOutCubic }, wheel };
    if (this.sparse && this.averageGap < FAST_STREAM_MS) {
      this.springing = true;
      return { pace: spring, wheel };
    }
    if (this.sparse) {
      return { pace: { duration: Math.min(gap + FRAME_MS, WHEEL_GLIDE_MS), ease: linear }, wheel };
    }
    return { pace: AT_ONCE, wheel };
  }
}
