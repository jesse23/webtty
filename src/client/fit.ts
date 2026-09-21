/**
 * Terminal grid sizing for the `#terminal` container.
 *
 * ghostty-web's `FitAddon` always subtracts a fixed 15px scrollbar reserve, which
 * leaves a visible strip at the edges even though the scrollbar is drawn as an
 * overlay inside the canvas. This computes the grid from the full container, so the
 * only space left over is the sub-cell remainder. See ADR 033.
 */

/** Fewest columns and rows the terminal is resized to (same as `FitAddon`). */
export const MIN_COLS = 2;
export const MIN_ROWS = 1;

export interface Grid {
  cols: number;
  rows: number;
}

/**
 * Cols and rows that fit in `width` x `height` CSS pixels of container, given the
 * cell size, after reserving `padding` px on each side. Returns `null` if the
 * container or cell size is not known yet.
 */
export function computeGrid(
  width: number,
  height: number,
  cellWidth: number,
  cellHeight: number,
  padding = 0,
): Grid | null {
  if (width <= 0 || height <= 0 || cellWidth <= 0 || cellHeight <= 0) return null;
  const inner = Math.max(0, padding) * 2;
  return {
    cols: Math.max(MIN_COLS, Math.floor((width - inner) / cellWidth)),
    rows: Math.max(MIN_ROWS, Math.floor((height - inner) / cellHeight)),
  };
}

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
