// The arithmetic of pixel-smooth scrolling (util, pure, ADR 040, ADR 043): a fractional
// scroll position as whole lines plus a device-pixel offset, and a wheel event's delta in
// lines.

/** A scroll position as ghostty-web's whole-line viewport and the renderer's pixel offset. */
export interface ScrollSplit {
  /** Whole lines scrolled up from the bottom: ghostty-web's viewportY. */
  line: number;
  /** Extra offset in CSS pixels, snapped to device pixels, in `[0, cellHeight)`. */
  offset: number;
}

/** Splits a fractional scroll `position` (lines up from the bottom) into whole lines and a pixel offset. */
export function splitScroll(position: number, cellHeight: number, dpr: number): ScrollSplit {
  const line = Math.floor(position);
  const offset = Math.round((position - line) * cellHeight * dpr) / dpr;
  // Rounding can reach a full cell; that is the next whole line with no offset.
  if (offset >= cellHeight) return { line: line + 1, offset: 0 };
  return { line, offset };
}

/** Lines a wheel event scrolls toward the bottom (negative: toward the top of scrollback). */
export function wheelLines(
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  rows: number,
): number {
  if (e.deltaMode === 1) return e.deltaY; // DOM_DELTA_LINE
  if (e.deltaMode === 2) return e.deltaY * rows; // DOM_DELTA_PAGE
  return e.deltaY / cellHeight;
}
