// The selectors that find the terminal's own canvas among the canvases webtty adds to the
// container: the edge strips (`data-edge`, ADR 035) and the kitty overlay (`data-kitty`,
// ADR 032) (constants + util). Each call site keeps the exact selector it used before.

/** The terminal canvas as the fit, the edge extender and the composer see it: not an edge strip. */
export const TERMINAL_CANVAS = 'canvas:not([data-edge])';

/**
 * The terminal canvas as the kitty overlay sees it: neither an edge strip nor the overlay
 * itself, which is a canvas in the same container.
 */
export const TERMINAL_CANVAS_UNDER_OVERLAY = 'canvas:not([data-kitty]):not([data-edge])';

/** The first canvas in `container` matching `selector`, the terminal's by default. */
export function terminalCanvas(
  container: ParentNode,
  selector: string = TERMINAL_CANVAS,
): HTMLCanvasElement | null {
  return container.querySelector<HTMLCanvasElement>(selector);
}
