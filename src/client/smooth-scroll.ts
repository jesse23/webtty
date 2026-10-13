/**
 * Pixel-smooth scrollback scrolling. See ADR 040 and ADR 043.
 *
 * ghostty-web draws whole rows only: its viewport is a line count, and a fractional
 * viewportY is floored when rows are picked. A trackpad reports pixel deltas, so
 * scrolling steps a whole line at a time behind a short easing animation.
 *
 * This keeps the scroll position as fractional lines. ghostty-web renders the whole
 * part as usual; the fraction becomes a pixel offset the renderer shows the viewport
 * at: its canvas also holds rows above and below the viewport, and shows the
 * viewport moved down by `fraction x cellHeight`, with the bottom of the row above
 * sliding into view. At a whole-line position there is no offset, so a resting
 * terminal renders exactly as before.
 *
 * A mouse wheel notch glides to its target instead of jumping there, and so does a
 * sparse stream of deltas such as a TrackPoint's (ADR 045); trackpad deltas, which
 * arrive every frame, apply at once.
 *
 * Only the normal screen's scrollback scrolls this way. On the alternate screen, or
 * when the app tracks the mouse, the app moves its own view in whole lines.
 */
import type { Terminal } from './vendor/ghostty-web';
import { springStep, type WheelPace } from './vendor/ghostty-web/terminal';

export interface ScrollSplit {
  /** Whole lines scrolled up from the bottom: ghostty-web's viewportY. */
  line: number;
  /** Extra offset in CSS pixels, snapped to device pixels, in `[0, cellHeight)`. */
  offset: number;
}

/** Splits a fractional scroll `position` (lines up from the bottom) into whole lines and a pixel offset. */
export function splitScroll(position: number, cellHeight: number, dpr: number): ScrollSplit {
  const line = Math.floor(position);
  const offset = Math.round((position - line) * cellHeight * dpr) / dpr;
  // Rounding can reach a full cell; that is the next whole line with no offset.
  if (offset >= cellHeight) return { line: line + 1, offset: 0 };
  return { line, offset };
}

/** Lines a wheel event scrolls toward the bottom (negative: toward the top of scrollback). */
export function wheelLines(
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  rows: number,
): number {
  if (e.deltaMode === 1) return e.deltaY; // DOM_DELTA_LINE
  if (e.deltaMode === 2) return e.deltaY * rows; // DOM_DELTA_PAGE
  return e.deltaY / cellHeight;
}

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

/** One frame at 60 Hz. */
const FRAME_MS = 1000 / 60;

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

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** The OS asks for less motion: wheel and sparse deltas then scroll at once. */
function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

function linear(t: number): number {
  return t;
}

/**
 * How a wheel event scrolls: over `duration` ms with `ease`, at once when 0, or
 * following a spring of stiffness `omega`.
 */
interface Motion extends WheelPace {
  ease: (t: number) => number;
  /** A wheel notch's motion, which reduced motion turns off everywhere. */
  wheel: boolean;
}

type Glide =
  | {
      kind: 'ease';
      from: number;
      to: number;
      start: number;
      duration: number;
      ease: (t: number) => number;
    }
  | { kind: 'spring'; to: number; omega: number };

export class SmoothScroll {
  /** Lines scrolled up from the bottom; fractional between rows. */
  private position = 0;
  private readonly classifier = new WheelClassifier();
  /** A glide in progress toward a wheel or sparse delta's target. */
  private glide: Glide | null = null;
  /** Timestamp of the glide's latest frame, whose position a new glide starts from. */
  private lastFrame: number | null = null;
  /** `timeStamp` and direction of the previous wheel event. */
  private lastWheel: number | null = null;
  private lastDir = 0;
  /** In a sparse stream, how many short gaps in a row it has had, and its average gap. */
  private sparse = false;
  private shortGaps = 0;
  private averageGap = 0;
  /** Scroll velocity in lines per second, kept across glides so a spring takes over smoothly. */
  private velocity = 0;
  /** Set while `apply` moves ghostty-web's viewport, whose onScroll is then our own. */
  private applying = false;

  constructor(private readonly term: Terminal) {
    // ghostty-web moves the viewport itself on new output (to the bottom), keyboard
    // scrolling and scrollbar drags. Follow it whenever it lands on a different line.
    term.onScroll((y: number) => {
      if (!this.applying && y !== Math.floor(this.position)) this.jump(y);
    });
    term.onResize(() => this.jump(term.viewportY));
  }

  /** Handles a wheel event on the normal screen. Returns false to leave it to ghostty-web. */
  handleWheel(e: WheelEvent): boolean {
    if (this.term.wasmTerm?.isAlternateScreen()) return false;
    const metrics = this.term.renderer?.getMetrics();
    if (!metrics) return false;
    const lines = wheelLines(e, metrics.height, this.term.rows);
    const classified = this.classify(e);
    const motion = reducedMotion() ? { ...classified, duration: 0, omega: undefined } : classified;
    // A delta during a glide adds to where the glide is heading.
    const to = this.clamp((this.glide?.to ?? this.position) - lines);
    if (motion.omega) {
      if (this.glide?.kind !== 'spring') this.lastFrame ??= performance.now() - FRAME_MS;
      this.glide = { kind: 'spring', to, omega: motion.omega };
    } else if (motion.duration > 0) {
      this.glideTo(to, motion.duration, motion.ease);
    } else {
      this.stopGlide();
      this.position = to;
      this.apply();
    }
    return true;
  }

  /**
   * Advances a glide. ghostty-web's render loop calls this just before it renders,
   * so the frame shows the glide's position for that frame, not the one before.
   */
  frame(now: number): void {
    const glide = this.glide;
    if (!glide) return;
    const before = this.position;
    const dt = Math.min(Math.max(now - (this.lastFrame ?? now - FRAME_MS), 0), 50) / 1000;
    let done: boolean;
    if (glide.kind === 'spring') {
      const [x, v] = springStep(this.position, this.velocity, glide.to, glide.omega, dt);
      this.velocity = v;
      done = Math.abs(glide.to - x) < 1e-3 && Math.abs(v) < 0.05;
      this.position = this.clamp(done ? glide.to : x);
    } else {
      // A frame's timestamp can precede the glide's start by part of a frame.
      const t = Math.min(1, Math.max(0, (now - glide.start) / glide.duration));
      this.position = this.clamp(glide.from + (glide.to - glide.from) * glide.ease(t));
      if (dt > 0) this.velocity = (this.position - before) / dt;
      done = t >= 1;
    }
    if (done) {
      this.glide = null;
      this.lastFrame = null;
      this.velocity = 0;
    } else {
      this.lastFrame = now;
    }
    this.apply();
  }

  /**
   * How long to spread the scroll ticks a wheel event sends to an app over, for
   * events this does not scroll itself, as the scrollback glides: a wheel notch's
   * over the wheel glide time, a sparse delta's over its gap plus a frame, so a
   * mouse wheel or TrackPoint scrolls an app a line at a time instead of in bursts.
   * Trackpad deltas, and everything with reduced motion, go at once (0). See ADR 045.
   */
  tickSpread(e: WheelEvent): WheelPace {
    const { duration, omega, wheel } = this.classify(e);
    // Pacing a sparse stream times input, it does not animate: kept with reduced motion.
    if (wheel && reducedMotion()) return { duration: 0 };
    return omega ? { duration, omega } : { duration };
  }

  /**
   * How a wheel event scrolls; call once per event, as it tracks the stream.
   * - A wheel notch eases out over the wheel glide time, or, soon after one in the
   *   same direction, continues linearly over its gap plus a frame.
   * - A sparse delta, 25 ms or more after the previous one, glides linearly over
   *   that gap plus a frame, so a stream scrolls at the speed it is sent at; the
   *   extra frame keeps the glide going when the next delta is a little late. A
   *   stream stays sparse until two short gaps in a row, so one delta that comes
   *   a little early does not snap or flush. While its deltas come every 60 ms or
   *   faster on average, it follows a spring instead, which evens out the speed.
   * - Trackpad deltas, a frame apart: at once.
   */
  private classify(e: WheelEvent): Motion {
    const gap = this.lastWheel === null ? 0 : e.timeStamp - this.lastWheel;
    this.lastWheel = e.timeStamp;
    const dir = Math.sign(e.deltaY);
    const sameDir = dir === this.lastDir;
    this.lastDir = dir;
    if (e.deltaMode === 0) this.classifier.accept(e.deltaX || 0, e.deltaY);
    const wheel = e.deltaMode !== 0 || this.classifier.isPhysicalMouseWheel();
    if (gap >= SPARSE_GAP_MS) {
      // A stream's first gap is the pause before it; count it as the slowest gap.
      const capped = Math.min(gap, WHEEL_GLIDE_MS);
      this.averageGap = this.sparse ? 0.4 * capped + 0.6 * this.averageGap : WHEEL_GLIDE_MS;
      this.sparse = true;
      this.shortGaps = 0;
    } else if (this.sparse && ++this.shortGaps >= 2) {
      this.sparse = false;
    }
    if (wheel && gap > 0 && gap <= STREAM_MS && sameDir) {
      return { duration: Math.min(gap + FRAME_MS, STREAM_MS), ease: linear, wheel };
    }
    if (wheel) return { duration: WHEEL_GLIDE_MS, ease: easeOutCubic, wheel };
    if (this.sparse && this.averageGap < FAST_STREAM_MS) {
      return { duration: WHEEL_GLIDE_MS, omega: STREAM_OMEGA, ease: linear, wheel };
    }
    if (this.sparse) {
      return { duration: Math.min(gap + FRAME_MS, WHEEL_GLIDE_MS), ease: linear, wheel };
    }
    return { duration: 0, ease: linear, wheel };
  }

  /** New output arrived. ghostty-web only snaps to the bottom when viewportY > 0, so clear a sub-line offset here. */
  onOutput(): void {
    if (this.term.viewportY === 0 && this.position !== 0) this.jump(0);
  }

  /**
   * Re-splits the position after a fit: a DPR or font change moves the device-pixel
   * grid and the cell height the offset was snapped to.
   */
  update(): void {
    this.apply();
  }

  private jump(line: number): void {
    this.stopGlide();
    this.position = line;
    this.apply();
  }

  private clamp(position: number): number {
    return Math.max(0, Math.min(this.term.getScrollbackLength(), position));
  }

  private glideTo(to: number, duration: number, ease: (t: number) => number): void {
    // Start from the glide's latest frame, or a frame ago: starting at this event would
    // give the next frame, whose timestamp precedes the event, nothing to move, and a
    // stream of deltas would stall every other frame.
    const start = this.lastFrame ?? performance.now() - FRAME_MS;
    this.glide = { kind: 'ease', from: this.position, to, start, duration, ease };
  }

  private stopGlide(): void {
    this.glide = null;
    this.lastFrame = null;
    this.velocity = 0;
  }

  private apply(): void {
    const renderer = this.term.renderer;
    const metrics = renderer?.getMetrics();
    if (!renderer || !metrics) return;
    const { line, offset } = splitScroll(
      this.position,
      metrics.height,
      window.devicePixelRatio || 1,
    );
    // Changes ghostty-web's viewportY synchronously. Its render loop draws the rows that
    // came into view and shows the offset on the next frame.
    // Rounding the offset can land on the next line while the position is still just
    // below it; that is our own move, not one to follow.
    if (line !== this.term.viewportY) {
      this.applying = true;
      try {
        this.term.scrollToLine(line);
      } finally {
        this.applying = false;
      }
    }
    renderer.setScrollOffset(offset);
  }
}
