/**
 * Extends the terminal's edge colours into the leftover strip at the right and bottom,
 * like Ghostty's `window-padding-color = extend`. See ADR 035.
 *
 * The canvas is fitted to whole cells, so less than one cell of the container is left
 * over. Each strip repaints the canvas' last pixel row (bottom) or column (right)
 * stretched across the leftover, so the strip takes on whatever background the edge
 * cells have: a dark sidebar stays dark, the main area stays light.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeRects {
  bottom: Rect | null;
  right: Rect | null;
}

/**
 * Where the strips go, in CSS pixels relative to the container's padding box. `canvas` is
 * the terminal canvas box and `container` its container's client size. The configured
 * `padding` on the far side of each strip is left to the padding colour.
 */
export function computeEdgeRects(
  canvas: { left: number; top: number; width: number; height: number },
  container: { width: number; height: number },
  padding: number,
): EdgeRects {
  const p = Math.max(0, padding);
  const bottomY = canvas.top + canvas.height;
  const rightX = canvas.left + canvas.width;
  const bottomHeight = container.height - bottomY - p;
  const rightWidth = container.width - rightX - p;
  return {
    bottom:
      bottomHeight > 0
        ? { x: canvas.left, y: bottomY, width: canvas.width, height: bottomHeight }
        : null,
    right:
      rightWidth > 0
        ? { x: rightX, y: canvas.top, width: rightWidth, height: canvas.height }
        : null,
  };
}

interface Strip {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
}

function createStrip(): Strip | null {
  const el = document.createElement('canvas');
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

export class EdgeExtender {
  private readonly bottom = createStrip();
  private readonly right = createStrip();
  private frame: number | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly padding: number,
  ) {
    // Appended after the terminal canvas, so `querySelector('canvas')` still finds that one.
    for (const strip of [this.bottom, this.right]) {
      if (strip) container.append(strip.el);
    }
  }

  /** Reposition the strips. Call after every fit, when the canvas or padding may have moved. */
  update(): void {
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
    const dpr = window.devicePixelRatio || 1;
    if (this.bottom) place(this.bottom, rects.bottom, dpr);
    if (this.right) place(this.right, rects.right, dpr);
    if (this.frame === null && (this.bottom?.visible || this.right?.visible)) {
      this.frame = window.requestAnimationFrame(this.paint);
    }
  }

  private terminalCanvas(): HTMLCanvasElement | null {
    return this.container.querySelector('canvas:not([data-edge])');
  }

  private readonly paint = (): void => {
    this.frame = null;
    const src = this.terminalCanvas();
    if (!src || src.width === 0 || src.height === 0) return;
    if (this.bottom?.visible) {
      const { ctx, el } = this.bottom;
      ctx.drawImage(src, 0, src.height - 1, src.width, 1, 0, 0, el.width, el.height);
    }
    if (this.right?.visible) {
      const { ctx, el } = this.right;
      ctx.drawImage(src, src.width - 1, 0, 1, src.height, 0, 0, el.width, el.height);
    }
    if (this.bottom?.visible || this.right?.visible) {
      this.frame = window.requestAnimationFrame(this.paint);
    }
  };
}
