// webtty (ADR 040, ADR 043, ADR 061), not from upstream.
// The viewport clip (object): places the drawing canvas over the terminal's canvas
// element, moves it up and clips it to the element's box so the viewport's rows show at a
// pixel offset, and reports the part in view.

/** The drawing canvas and the part of it in view, in canvas pixels; the rest is overscan. */
export interface VisibleArea {
  canvas: HTMLCanvasElement;
  y: number;
  height: number;
  /** The bottom pixel line of the viewport's last row, below the part in view at a fraction. */
  lastLine: number;
  /** Changes whenever the canvas is drawn on, so a copy of its pixels can tell it is stale. */
  version: number;
}

/**
 * Creates the canvas the rows are drawn on, inserted before `element`. Positioned with no
 * offsets, it sits where the element's box starts (its static position), wherever padding
 * moves it. Positioned, it paints over the element, and lets the mouse through to it.
 * (webtty, ADR 043)
 */
export function createDrawingCanvas(
  doc: Pick<Document, 'createElement'>,
  element: HTMLCanvasElement
): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.pointerEvents = 'none';
  canvas.style.display = 'block';
  // Excluded from the lookups of the terminal canvas, like the edge strips
  canvas.dataset.edge = 'true';
  element.parentNode?.insertBefore(canvas, element);
  return canvas;
}

/**
 * Shows `rows` rows of the canvas from a canvas row, moved down by an offset. Only style
 * values that changed are written.
 */
export class ViewportClip {
  // The offset the rows are shown at, in CSS pixels
  private shownOffset = 0;
  // CSS pixels from the canvas top to the top of what is shown
  private shownTop = 0;
  private shownRows = 0;
  private shownTransform = '';
  private shownClip = '';

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** The offset the viewport is shown at, in CSS pixels. */
  get offset(): number {
    return this.shownOffset;
  }

  /**
   * Shows the `rows` rows from canvas row `top` of a canvas `total` rows of
   * `cellHeight` high, moved down by `offset`: moves the canvas up by what is above them
   * and clips it to the element's box. A transform places it to the device pixel;
   * object-position would round to CSS pixels.
   */
  show(top: number, offset: number, rows: number, total: number, cellHeight: number): void {
    this.shownOffset = offset;
    this.shownTop = top * cellHeight - offset;
    this.shownRows = rows;
    const below = (total - rows) * cellHeight - this.shownTop;
    const transform = `translateY(${-this.shownTop}px)`;
    const clip = `inset(${this.shownTop}px 0px ${below}px 0px)`;
    if (transform !== this.shownTransform) {
      this.canvas.style.transform = transform;
      this.shownTransform = transform;
    }
    if (clip !== this.shownClip) {
      this.canvas.style.clipPath = clip;
      this.shownClip = clip;
    }
  }

  /** The part in view at ratio `dpr` and rows `cellHeight` high, tagged with `version`. */
  area(dpr: number, cellHeight: number, version: number): VisibleArea {
    const bottom = this.shownTop + this.shownOffset + this.shownRows * cellHeight;
    return {
      canvas: this.canvas,
      y: Math.round(this.shownTop * dpr),
      height: this.shownRows * cellHeight * dpr,
      lastLine: Math.round(bottom * dpr) - 1,
      version,
    };
  }
}
