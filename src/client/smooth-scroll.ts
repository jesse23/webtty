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

function linear(t: number): number {
  return t;
}

interface Glide {
  from: number;
  to: number;
  start: number;
  duration: number;
  ease: (t: number) => number;
}

export class SmoothScroll {
  /** Lines scrolled up from the bottom; fractional between rows. */
  private position = 0;
  private readonly classifier = new WheelClassifier();
  /** A glide in progress toward a wheel or sparse delta's target. */
  private glide: Glide | null = null;
  private frame = 0;
  /** Timestamp of the glide's latest frame, whose position a new glide starts from. */
  private lastFrame: number | null = null;
  /** `timeStamp` of the previous wheel event. */
  private lastWheel: number | null = null;

  constructor(private readonly term: Terminal) {
    // ghostty-web moves the viewport itself on new output (to the bottom), keyboard
    // scrolling and scrollbar drags. Follow it whenever it lands on a different line.
    term.onScroll((y: number) => {
      if (y !== Math.floor(this.position)) this.jump(y);
    });
    term.onResize(() => this.jump(term.viewportY));
  }

  /** Handles a wheel event on the normal screen. Returns false to leave it to ghostty-web. */
  handleWheel(e: WheelEvent): boolean {
    if (this.term.wasmTerm?.isAlternateScreen()) return false;
    const metrics = this.term.renderer?.getMetrics();
    if (!metrics) return false;
    const lines = wheelLines(e, metrics.height, this.term.rows);
    const { wheel, gap } = this.classify(e);
    // A delta during a glide adds to where the glide is heading.
    const to = this.clamp((this.glide?.to ?? this.position) - lines);
    if (wheel) {
      this.glideTo(to, WHEEL_GLIDE_MS, easeOutCubic);
    } else if (gap >= SPARSE_GAP_MS) {
      // Spread the delta over the time it took to arrive, so a steady stream scrolls
      // at a steady speed, the speed of the input. One frame more keeps the glide
      // going until the next delta when the stream slows down a little.
      this.glideTo(to, Math.min(gap + FRAME_MS, WHEEL_GLIDE_MS), linear);
    } else {
      this.stopGlide();
      this.position = to;
      this.apply();
    }
    return true;
  }

  /**
   * How long to spread the scroll ticks a wheel event sends to an app over, for
   * events this does not scroll itself. A sparse delta's ticks spread over its gap
   * plus a frame, so a TrackPoint scrolls an app a line at a time instead of in
   * bursts; a wheel notch's or trackpad delta's go at once (0). See ADR 045.
   */
  tickSpread(e: WheelEvent): number {
    const { wheel, gap } = this.classify(e);
    return !wheel && gap >= SPARSE_GAP_MS ? Math.min(gap + FRAME_MS, WHEEL_GLIDE_MS) : 0;
  }

  /** Classifies a wheel event, once per event: a wheel notch or not, and the time since the previous one. */
  private classify(e: WheelEvent): { wheel: boolean; gap: number } {
    const gap = this.lastWheel === null ? 0 : e.timeStamp - this.lastWheel;
    this.lastWheel = e.timeStamp;
    if (e.deltaMode === 0) this.classifier.accept(e.deltaX || 0, e.deltaY);
    return { wheel: e.deltaMode !== 0 || this.classifier.isPhysicalMouseWheel(), gap };
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
    this.glide = { from: this.position, to, start, duration, ease };
    if (!this.frame) this.frame = window.requestAnimationFrame(this.step);
  }

  private stopGlide(): void {
    this.glide = null;
    this.lastFrame = null;
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly step = (now: number): void => {
    this.frame = 0;
    const glide = this.glide;
    if (!glide) return;
    // A frame's timestamp can precede the glide's start by part of a frame.
    const t = Math.min(1, Math.max(0, (now - glide.start) / glide.duration));
    this.position = this.clamp(glide.from + (glide.to - glide.from) * glide.ease(t));
    if (t < 1) {
      this.lastFrame = now;
      this.frame = window.requestAnimationFrame(this.step);
    } else {
      this.glide = null;
      this.lastFrame = null;
    }
    this.apply();
  };

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
    if (line !== this.term.viewportY) this.term.scrollToLine(line);
    renderer.setScrollOffset(offset);
  }
}
