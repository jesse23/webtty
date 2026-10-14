/**
 * Pixel-smooth scrollback scrolling (object over the terminal, ADR 040, ADR 043, ADR 045).
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
 * Only the normal screen's scrollback scrolls this way. On the alternate screen, or
 * when the app tracks the mouse, the app moves its own view in whole lines.
 */
import { Glide, type Terminal } from '../../vendor/ghostty-web';
import { splitScroll, wheelLines } from './scroll-split';
import type { WheelStream } from './wheel-stream';

/** Scrolls the terminal's scrollback by pixels: a fractional position that glides. */
export class SmoothScroll {
  /** The position in lines scrolled up from the bottom, fractional between rows. */
  private readonly glide = new Glide();
  /** Set while `apply` moves ghostty-web's viewport, whose onScroll is then our own. */
  private applying = false;

  constructor(
    private readonly term: Terminal,
    private readonly stream: WheelStream,
  ) {
    // ghostty-web moves the viewport itself on new output (to the bottom), keyboard
    // scrolling and scrollbar drags. Follow it whenever it lands on a different line.
    term.onScroll((y: number) => {
      if (!this.applying && y !== Math.floor(this.glide.value)) this.jump(y);
    });
    term.onResize(() => this.jump(term.viewportY));
  }

  /** Handles a wheel event on the normal screen. Returns false to leave it to ghostty-web. */
  handleWheel(e: WheelEvent): boolean {
    if (this.term.wasmTerm?.isAlternateScreen()) return false;
    const metrics = this.term.renderer?.getMetrics();
    if (!metrics) return false;
    const lines = wheelLines(e, metrics.height, this.term.rows);
    // A delta during a glide adds to where the glide is heading.
    const to = this.clamp(this.glide.target - lines);
    this.glide.retarget(to, this.stream.forScrollback(e), performance.now());
    if (!this.glide.active) this.apply();
    return true;
  }

  /**
   * Advances a glide. ghostty-web's render loop calls this just before it renders,
   * so the frame shows the glide's position for that frame, not the one before.
   */
  frame(now: number): void {
    if (!this.glide.active) return;
    // A spring has arrived once within half a device pixel.
    const height = this.term.renderer?.getMetrics()?.height ?? 15;
    this.glide.step(now, 0.5 / (height * (window.devicePixelRatio || 1)));
    this.glide.value = this.clamp(this.glide.value);
    this.apply();
  }

  /** New output arrived. ghostty-web only snaps to the bottom when viewportY > 0, so clear a sub-line offset here. */
  onOutput(): void {
    if (this.term.viewportY === 0 && this.glide.value !== 0) this.jump(0);
  }

  /**
   * Re-splits the position after a fit: a DPR or font change moves the device-pixel
   * grid and the cell height the offset was snapped to.
   */
  update(): void {
    this.apply();
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
      window.devicePixelRatio || 1,
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
  }
}
