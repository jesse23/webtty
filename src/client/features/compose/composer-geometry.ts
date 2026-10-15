// Where the composition overlay goes (util, pure, ADR 038): over the cursor cell, one cell
// high, and no wider than the canvas leaves to the right of the cursor.

/** The overlay's box in CSS pixels, relative to the terminal container. */
export interface OverlayBox {
  left: number;
  top: number;
  height: number;
  lineHeight: number;
  maxWidth: number;
}

/**
 * The overlay's box for the cursor cell at `spot`, cells `cell` in size, with the canvas'
 * right edge at `canvasRight` (null without a canvas: the overlay is at least a cell wide).
 */
export function overlayBox(
  spot: { left: number; top: number },
  cell: { width: number; height: number },
  canvasRight: number | null,
): OverlayBox {
  const right = canvasRight ?? spot.left;
  return {
    left: spot.left,
    top: spot.top,
    height: cell.height,
    lineHeight: cell.height,
    maxWidth: Math.max(cell.width, right - spot.left),
  };
}
