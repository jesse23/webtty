// The browser's page zoom, as far as a page can tell it (util, pure, ADR 045): Chromium
// divides a mouse wheel notch's pixels by the zoom, so at 110% a notch of 100 px arrives as
// 90.909… and no longer looks like a notch. VS Code multiplies the deltas back by its own
// zoom factor before classifying them; a page has no such value, but the window's outer
// width is in screen pixels and its inner width in CSS pixels, so their ratio is the zoom.

/** Chromium's preset zoom levels (`kPresetZoomFactors`), which the menu and Cmd+/- step through. */
export const ZOOM_LEVELS = [
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  0.75,
  0.8,
  0.9,
  1,
  1.1,
  1.25,
  1.5,
  1.75,
  2,
  2.5,
  3,
  4,
  5,
] as const;

/**
 * How far the measured ratio may be from a preset, relative: the outer width can include a
 * window frame or a scrollbar of a few pixels.
 */
const TOLERANCE = 0.02;

/** The preset zoom level `ratio` stands for, or 1 when it is near none (a side panel open). */
export function snapZoom(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  let best = 1;
  let bestError = TOLERANCE;
  for (const level of ZOOM_LEVELS) {
    const error = Math.abs(ratio / level - 1);
    if (error < bestError) {
      best = level;
      bestError = error;
    }
  }
  return best;
}

/** The window sizes the zoom is read from. */
export type ZoomWindow = Partial<Pick<Window, 'outerWidth' | 'innerWidth'>>;

/** The page zoom of `win`, 1 when its sizes are missing. */
export function pageZoom(win: ZoomWindow): number {
  const { outerWidth, innerWidth } = win;
  if (!outerWidth || !innerWidth) return 1;
  return snapZoom(outerWidth / innerWidth);
}
