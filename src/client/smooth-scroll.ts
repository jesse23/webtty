/**
 * Pixel-smooth scrollback scrolling. See ADR 040.
 *
 * ghostty-web draws whole rows only: its viewport is a line count, and a fractional
 * viewportY is floored when rows are picked. A trackpad reports pixel deltas, so
 * scrolling steps a whole line at a time behind a short easing animation.
 *
 * This keeps the scroll position as fractional lines. ghostty-web renders the whole
 * part as usual; the fraction becomes a CSS offset: the canvas moves down by
 * `fraction x cellHeight` (its bottom edge clipped), and a one-row strip above it
 * shows the scrollback line that slides into view, drawn with ghostty-web's own
 * renderLine. At a whole-line position the canvas has no transform and the strip is
 * hidden, so a resting terminal renders exactly as before.
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

type Cell = NonNullable<ReturnType<Terminal['getScrollbackLine']>>[number];

interface RendererInternals {
  ctx: CanvasRenderingContext2D;
  renderLine(line: Cell[], row: number, cols: number, grapheme: (col: number) => string): void;
}

export class SmoothScroll {
  /** Lines scrolled up from the bottom; fractional between rows. */
  private position = 0;
  private readonly strip: HTMLCanvasElement;
  private readonly stripCtx: CanvasRenderingContext2D | null;

  constructor(
    private readonly term: Terminal,
    private readonly container: HTMLElement,
  ) {
    this.strip = document.createElement('canvas');
    this.stripCtx = this.strip.getContext('2d');
    this.strip.style.position = 'absolute';
    this.strip.style.pointerEvents = 'none';
    this.strip.style.display = 'none';
    // Excluded from the edge and graphics `canvas` lookups like the edge strips.
    this.strip.dataset.edge = 'true';
    container.append(this.strip);

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
    const max = this.term.getScrollbackLength();
    const lines = wheelLines(e, metrics.height, this.term.rows);
    this.position = Math.max(0, Math.min(max, this.position - lines));
    this.apply();
    return true;
  }

  /** New output arrived. ghostty-web only snaps to the bottom when viewportY > 0, so clear a sub-line offset here. */
  onOutput(): void {
    if (this.term.viewportY === 0 && this.position !== 0) this.jump(0);
  }

  /** Re-applies the offset after a fit moved or resized the canvas. */
  update(): void {
    this.apply();
  }

  private jump(line: number): void {
    this.position = line;
    this.apply();
  }

  private apply(): void {
    const renderer = this.term.renderer as unknown as RendererInternals | undefined;
    const metrics = this.term.renderer?.getMetrics();
    const canvas = this.container.querySelector<HTMLCanvasElement>('canvas:not([data-edge])');
    if (!renderer || !metrics || !canvas) return;
    const { line, offset } = splitScroll(
      this.position,
      metrics.height,
      window.devicePixelRatio || 1,
    );
    // Changes ghostty-web's viewportY synchronously; its render loop redraws the rows on
    // the next frame, the same frame the transform below lands in.
    if (line !== this.term.viewportY) this.term.scrollToLine(line);
    if (offset === 0) {
      canvas.style.transform = '';
      canvas.style.clipPath = '';
      this.strip.style.display = 'none';
      return;
    }
    canvas.style.transform = `translateY(${offset}px)`;
    canvas.style.clipPath = `inset(0 0 ${offset}px 0)`;
    this.drawStrip(renderer, canvas, line, offset, metrics.height);
  }

  /** Draws the scrollback line just above the viewport into the strip over the canvas' top edge. */
  private drawStrip(
    renderer: RendererInternals,
    canvas: HTMLCanvasElement,
    line: number,
    offset: number,
    cellHeight: number,
  ): void {
    const ctx = this.stripCtx;
    const sbOffset = this.term.getScrollbackLength() - line - 1;
    const cells = this.term.getScrollbackLine(sbOffset);
    if (!ctx || !cells) {
      this.strip.style.display = 'none';
      return;
    }
    const dpr = this.term.renderer?.devicePixelRatio ?? 1;
    const width = canvas.offsetWidth;
    const w = Math.round(width * dpr);
    const h = Math.round(cellHeight * dpr);
    if (this.strip.width !== w) this.strip.width = w;
    if (this.strip.height !== h) this.strip.height = h;
    this.strip.style.width = `${width}px`;
    this.strip.style.height = `${cellHeight}px`;
    this.strip.style.left = `${canvas.offsetLeft}px`;
    this.strip.style.top = `${canvas.offsetTop + offset - cellHeight}px`;
    this.strip.style.clipPath = `inset(${cellHeight - offset}px 0 0 0)`;
    this.strip.style.display = 'block';

    // renderLine draws row `r` at y = r x cellHeight into renderer.ctx. Borrow it with the
    // strip's context, shifted down a row so row -1 lands at y = 0. Row -1 is never in a
    // selection, so the line draws unselected. Graphemes come from the same scrollback row.
    ctx.setTransform(dpr, 0, 0, dpr, 0, cellHeight * dpr);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const own = renderer.ctx;
    renderer.ctx = ctx;
    try {
      renderer.renderLine(cells, -1, this.term.cols, (col) =>
        this.term.getScrollbackGraphemeString(sbOffset, col),
      );
    } finally {
      renderer.ctx = own;
    }
  }
}
