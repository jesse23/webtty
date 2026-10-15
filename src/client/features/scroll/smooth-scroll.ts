/**
 * Pixel-smooth scrollback scrolling (object over the terminal, ADR 040, ADR 043, ADR 045,
 * ADR 066).
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
 * The position moves as a `Glide`, at the pace `WheelStream` picks for each event:
 * a mouse wheel notch or a TrackPoint's sparse deltas glide, trackpad deltas, which
 * arrive every frame, apply at once.
 *
 * Output keeps a scrolled view on its text: ghostty-web moves its viewport with the text
 * on each write, announcing nothing, and the glide moves by as much, keeping its fraction
 * and its motion (ADR 066).
 *
 * Only the normal screen's scrollback scrolls this way. On the alternate screen, or
 * when the app tracks the mouse, the app moves its own view in whole lines.
 */
import { type Disposable, DisposableStore, Glide, type Terminal } from '../../vendor/ghostty-web';
import { splitScroll, wheelLines } from './scroll-split';
import type { WheelStream } from './wheel-stream';

/** The browser objects the scroll reads: the device pixel ratio, at every split, and the clock. */
export interface SmoothScrollDeps {
  window: Pick<Window, 'devicePixelRatio'>;
  performance: Pick<Performance, 'now'>;
}

/** Scrolls the terminal's scrollback by pixels: a fractional position that glides. */
export class SmoothScroll implements Disposable {
  /** The position in lines scrolled up from the bottom, fractional between rows. */
  private readonly glide = new Glide();
  private readonly store = new DisposableStore();
  /** Set while `apply` moves ghostty-web's viewport, whose onScroll is then our own. */
  private applying = false;
  /** ghostty-web's viewport line as the last `apply` left it. */
  private line = 0;

  constructor(
    private readonly term: Terminal,
    private readonly stream: WheelStream,
    private readonly deps: SmoothScrollDeps = { window, performance },
  ) {
    // ghostty-web moves the viewport itself on a key or a paste (to the bottom, which also
    // drops a sub-line offset), keyboard scrolling, scrollbar drags and find. Follow it
    // whenever it lands anywhere but where the glide is.
    this.store.add(
      term.onScroll((y: number) => {
        if (!this.applying && y !== this.glide.value) this.jump(y);
      }),
    );
    this.store.add(term.onResize(() => this.jump(term.viewportY)));
  }

  /** Stops following the terminal's scroll and resize. Idempotent. */
  dispose(): void {
    this.store.dispose();
  }

  /** Handles a wheel event on the normal screen. Returns false to leave it to ghostty-web. */
  handleWheel(e: WheelEvent): boolean {
    if (this.term.wasmTerm?.isAlternateScreen()) return false;
    const metrics = this.term.renderer?.getMetrics();
    if (!metrics) return false;
    this.follow();
    const lines = wheelLines(e, metrics.height, this.term.rows);
    // A delta during a glide adds to where the glide is heading.
    const to = this.clamp(this.glide.target - lines);
    this.glide.retarget(to, this.stream.forScrollback(e), this.deps.performance.now());
    if (!this.glide.active) this.apply();
    return true;
  }

  /**
   * Advances a glide. ghostty-web's render loop calls this just before it renders,
   * so the frame shows the glide's position for that frame, not the one before.
   */
  frame(now: number): void {
    this.follow();
    if (!this.glide.active) return;
    // A spring has arrived once within half a device pixel.
    const height = this.term.renderer?.getMetrics()?.height ?? 15;
    this.glide.step(now, 0.5 / (height * (this.deps.window.devicePixelRatio || 1)));
    this.glide.value = this.clamp(this.glide.value);
    this.apply();
  }

  /** New output was written: the glide follows where it kept the view. */
  onOutput(): void {
    this.follow();
  }

  /**
   * Re-splits the position after a fit: a DPR or font change moves the device-pixel
   * grid and the cell height the offset was snapped to.
   */
  update(): void {
    this.apply();
  }

  /**
   * Catches up with ghostty-web's view after writes, which move it with its text without
   * an onScroll (Viewport.unpin, ADR 066): from any write, so `onOutput`, the next frame and
   * the next wheel event all call this. The glide moves by as many lines, keeping its
   * fraction and its motion; one heading for the bottom still ends there, so a scroll down
   * reaches output that keeps coming, and one heading past the oldest line (pruned at the
   * scrollback limit) eases in to the oldest line left. A view back at the bottom (the scrollback was cleared,
   * or the alternate screen came up) drops the glide, as does a scrollback that shrank under
   * a sub-line offset.
   */
  private follow(): void {
    const y = this.term.viewportY;
    if (y !== this.line) {
      if (y === 0) {
        this.jump(0);
      } else {
        const delta = y - this.line;
        const glide = this.glide;
        glide.shift(
          delta,
          glide.active && glide.target === 0 ? 0 : this.clamp(glide.target + delta),
        );
        this.glide.value = this.clamp(this.glide.value);
        this.apply();
      }
    } else if (this.glide.value > this.term.getScrollbackLength()) {
      this.jump(this.clamp(this.glide.value));
    }
  }

  private jump(line: number): void {
    this.glide.jump(line);
    this.apply();
  }

  private clamp(position: number): number {
    return Math.max(0, Math.min(this.term.getScrollbackLength(), position));
  }

  private apply(): void {
    const renderer = this.term.renderer;
    const metrics = renderer?.getMetrics();
    if (!renderer || !metrics) return;
    const { line, offset } = splitScroll(
      this.glide.value,
      metrics.height,
      this.deps.window.devicePixelRatio || 1,
    );
    // Changes ghostty-web's viewportY synchronously. Its render loop draws the rows that
    // came into view and shows the offset on the next frame. Rounding the offset can land
    // on the next line while the position is still just below it; that is our own move,
    // not one to follow.
    if (line !== this.term.viewportY) {
      this.applying = true;
      try {
        this.term.scrollToLine(line);
      } finally {
        this.applying = false;
      }
    }
    renderer.setScrollOffset(offset);
    this.line = this.term.viewportY;
  }
}
