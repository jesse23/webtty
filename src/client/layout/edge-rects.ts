// Where the edge strips go (util, pure, ADR 035): the leftover of the container at the
// right and bottom of the whole-cell canvas, less the configured padding.

/** A box in CSS pixels, relative to the container's padding box. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The two strips; null where nothing is left over. */
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
