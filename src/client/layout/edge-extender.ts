/**
 * Extends the terminal's edge colours into the leftover strip at the right and bottom,
 * like Ghostty's `window-padding-color = extend` (view, ADR 035).
 *
 * The canvas is fitted to whole cells, so less than one cell of the container is left
 * over. Each strip repaints the canvas' last pixel row (bottom) or column (right)
 * stretched across the leftover, so the strip takes on whatever background the edge
 * cells have: a dark sidebar stays dark, the main area stays light.
 */
import { computeEdgeRects, type Rect } from './edge-rects';

/** A canvas and the rows of it in view, in canvas pixels. */
export interface VisibleArea {
  canvas: HTMLCanvasElement;
  y: number;
  height: number;
  /**
   * The bottom pixel line of the last row in view. At a fraction of a line the part in
   * view ends inside that row, through its glyphs; its own last line is the background.
   */
  lastLine: number;
  /** Changes whenever the canvas is drawn on; absent: assume it changed every frame. */
  version?: number;
}

/** The browser objects the strips are built in and painted with. */
export interface EdgeExtenderDeps {
  document: Document;
  window: Pick<Window, 'devicePixelRatio' | 'requestAnimationFrame' | 'cancelAnimationFrame'>;
}

interface Strip {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
}

function createStrip(doc: Document): Strip | null {
  const el = doc.createElement('canvas');
  const ctx = el.getContext('2d');
  if (!ctx) return null;
  el.style.position = 'absolute';
  el.style.pointerEvents = 'none';
  el.style.display = 'none';
  el.dataset.edge = 'true';
  return { el, ctx, visible: false };
}

function place(strip: Strip, rect: Rect | null, dpr: number): void {
  if (!rect) {
    strip.visible = false;
    strip.el.style.display = 'none';
    return;
  }
  strip.visible = true;
  strip.el.style.display = 'block';
  strip.el.style.left = `${rect.x}px`;
  strip.el.style.top = `${rect.y}px`;
  strip.el.style.width = `${rect.width}px`;
  strip.el.style.height = `${rect.height}px`;
  strip.el.width = Math.max(1, Math.round(rect.width * dpr));
  strip.el.height = Math.max(1, Math.round(rect.height * dpr));
  strip.ctx.imageSmoothingEnabled = false;
}

/** The two strips, placed after each fit and repainted from the canvas edges each frame. */
export class EdgeExtender {
  private readonly bottom: Strip | null;
  private readonly right: Strip | null;
  private frame: number | null = null;
  /** What the strips were last copied from, so an unchanged frame copies nothing. */
  private painted = '';
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly padding: number,
    /**
     * The canvas the terminal draws on and the part of it in view, in canvas pixels, when
     * that is not the terminal canvas (ADR 043). Undefined: all of the terminal canvas.
     */
    private readonly visibleArea: () => VisibleArea | undefined = () => undefined,
    private readonly deps: EdgeExtenderDeps = { document: container.ownerDocument, window },
  ) {
    this.bottom = createStrip(deps.document);
    this.right = createStrip(deps.document);
    // Marked so the lookups of the terminal canvas skip them.
    for (const strip of [this.bottom, this.right]) {
      if (strip) container.append(strip.el);
    }
  }

  /** Reposition the strips. Call after every fit, when the canvas or padding may have moved. */
  update(): void {
    if (this.disposed) return;
    const canvas = this.terminalCanvas();
    if (!canvas) return;
    const rects = computeEdgeRects(
      {
        left: canvas.offsetLeft,
        top: canvas.offsetTop,
        width: canvas.offsetWidth,
        height: canvas.offsetHeight,
      },
      { width: this.container.clientWidth, height: this.container.clientHeight },
      this.padding,
    );
    const dpr = this.deps.window.devicePixelRatio || 1;
    if (this.bottom) place(this.bottom, rects.bottom, dpr);
    if (this.right) place(this.right, rects.right, dpr);
    this.painted = '';
    if (this.frame === null && (this.bottom?.visible || this.right?.visible)) {
      this.frame = this.deps.window.requestAnimationFrame(this.paint);
    }
  }

  /** Stops the paint loop and removes the strips. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) this.deps.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.bottom?.el.remove();
    this.right?.el.remove();
  }

  private terminalCanvas(): HTMLCanvasElement | null {
    return this.container.querySelector('canvas:not([data-edge])');
  }

  private readonly paint = (): void => {
    this.frame = null;
    const terminal = this.terminalCanvas();
    const area =
      this.visibleArea() ??
      (terminal
        ? { canvas: terminal, y: 0, height: terminal.height, lastLine: terminal.height - 1 }
        : null);
    const src = area?.canvas;
    if (!area || !src || src.width === 0 || area.height === 0) return;
    // Copying every frame kept the compositor from ever idling; copy only on a change.
    const from =
      area.version === undefined
        ? ''
        : `${area.version} ${area.y} ${area.height} ${area.lastLine} ${src.width}`;
    const unchanged = from !== '' && from === this.painted;
    this.painted = from;
    if (unchanged) {
      this.frame = this.deps.window.requestAnimationFrame(this.paint);
      return;
    }
    if (this.bottom?.visible) {
      const { ctx, el } = this.bottom;
      ctx.drawImage(src, 0, area.lastLine, src.width, 1, 0, 0, el.width, el.height);
    }
    if (this.right?.visible) {
      const { ctx, el } = this.right;
      ctx.drawImage(src, src.width - 1, area.y, 1, area.height, 0, 0, el.width, el.height);
    }
    if (this.bottom?.visible || this.right?.visible) {
      this.frame = this.deps.window.requestAnimationFrame(this.paint);
    }
  };
}
