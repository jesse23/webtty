// Derived from coder/ghostty-web lib/renderer.ts and lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The scrollbar's geometry (util): its column, track and thumb in CSS pixels, so the
// painter and the terminal's mouse hit test agree (ADR 061).

/** The track and thumb width. */
export const SCROLLBAR_WIDTH = 8;
/** The gap between the track and the right edge. */
export const SCROLLBAR_MARGIN = 4;
/** The track's inset from the top and bottom of the rows in view. */
export const SCROLLBAR_PADDING = 4;
/** The thumb's height when the scrollback is long. */
export const SCROLLBAR_MIN_THUMB = 20;

/** The track's left edge on a canvas `width` wide. */
export function scrollbarX(width: number): number {
  return width - SCROLLBAR_WIDTH - SCROLLBAR_MARGIN;
}

/** Whether `x` is in the scrollbar's column on a canvas `width` wide, edges included. */
export function inScrollbarColumn(x: number, width: number): boolean {
  const left = scrollbarX(width);
  return x >= left && x <= left + SCROLLBAR_WIDTH;
}

/** The track's height over rows in view `height` high. */
export function scrollbarTrackHeight(height: number): number {
  return height - SCROLLBAR_PADDING * 2;
}

/** The thumb's height: the share of all lines in view, at least SCROLLBAR_MIN_THUMB. */
export function scrollbarThumbHeight(
  visibleRows: number,
  scrollbackLength: number,
  trackHeight: number
): number {
  const totalLines = scrollbackLength + visibleRows;
  return Math.max(SCROLLBAR_MIN_THUMB, (visibleRows / totalLines) * trackHeight);
}

/**
 * The thumb's top, from the top of the rows in view: at the bottom of the track at
 * viewportY 0, at its top at viewportY `scrollbackLength`.
 */
export function scrollbarThumbY(
  viewportY: number,
  scrollbackLength: number,
  trackHeight: number,
  thumbHeight: number
): number {
  const scrollPosition = viewportY / scrollbackLength; // 0 to 1
  return SCROLLBAR_PADDING + (trackHeight - thumbHeight) * (1 - scrollPosition);
}
