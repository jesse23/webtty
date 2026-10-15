/**
 * Padding around the canvas in the `#terminal` container (util, pure, ADR 033).
 *
 * The vendored `FitAddon` sizes the grid from the full container, with no scrollbar
 * reserve, so the only space left over is the sub-cell remainder. This places that
 * remainder and the configured padding around the canvas.
 */

/** The padding on each side of the canvas, in CSS pixels. */
export interface Insets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Padding to apply on each side of the canvas. `hGap` and `vGap` are the total space
 * left over in the container (container size minus canvas size), including the
 * configured `padding` on both sides. The top and left edges are exactly `padding`;
 * the leftover, less than one cell, goes to the right and bottom, like most terminal
 * emulators. So `padding` alone decides the gap at the top and left, and `0` puts the
 * terminal flush against whatever is above and to the left of it.
 */
export function computeInsets(hGap: number, vGap: number, padding: number): Insets {
  const p = Math.max(0, padding);
  return {
    left: p,
    right: Math.max(p, hGap - p),
    top: p,
    bottom: Math.max(p, vGap - p),
  };
}
