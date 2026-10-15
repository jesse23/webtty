// webtty (ADR 042, ADR 061), not from upstream.
// One frame's row readers (util): the viewport read once and served as row slices, so a
// frame never copies and parses the whole viewport per row, and the line and grapheme
// lookup a canvas row shows, from the scrollback or the screen.

import type { GhosttyCell } from '../engine/cell-types';
import type { GraphemeLookup, IRenderable, IScrollbackProvider, RowContent } from './renderable';

/**
 * Returns a row reader for one frame. When the buffer has getViewport, the
 * viewport is read once, on the first row asked for, and every row is a slice of
 * that snapshot; getLine copies and parses the whole viewport on each call.
 */
export function frameLines(
  buffer: Pick<IRenderable, 'getLine' | 'getViewport'>,
  cols: number,
  rows: number
): (y: number) => GhosttyCell[] | null {
  if (!buffer.getViewport) return (y) => buffer.getLine(y);
  let viewport: GhosttyCell[] | null = null;
  return (y) => {
    if (y < 0 || y >= rows) return null;
    viewport ??= buffer.getViewport!();
    return viewport.slice(y * cols, (y + 1) * cols);
  };
}

/** Grapheme lookup for a screen row. */
export function screenGraphemes(buffer: IRenderable | null, row: number): GraphemeLookup {
  return (col) => buffer?.getGraphemeString?.(row, col) ?? ' ';
}

/** Grapheme lookup for a scrollback row. */
export function scrollbackGraphemes(
  provider: IScrollbackProvider,
  offset: number
): GraphemeLookup {
  return (col) => provider.getScrollbackGraphemeString?.(offset, col) ?? ' ';
}

/** Where a frame's rows come from: the screen and its reader, and the scrollback above it. */
export interface RowSource {
  buffer: IRenderable;
  getLine: (y: number) => GhosttyCell[] | null;
  rows: number;
  scrollback: IScrollbackProvider | undefined;
  scrollbackLength: number;
}

/**
 * The line at viewport row `y` for `viewportY`, from scrollback or the screen, with a
 * grapheme lookup on the same source: canvas row y is not screen row y while scrolled.
 * Null above the scrollback and below the screen. (webtty)
 */
export function rowContent(source: RowSource, y: number, viewportY: number): RowContent {
  if (y < viewportY) {
    // This row is from scrollback, counted from its end
    const scrollbackOffset = source.scrollbackLength - viewportY + y;
    if (!source.scrollback || scrollbackOffset < 0) return { line: null };
    return {
      line: source.scrollback.getScrollbackLine(scrollbackOffset),
      grapheme: scrollbackGraphemes(source.scrollback, scrollbackOffset),
    };
  }
  // This row is from the screen
  const screenRow = y - viewportY;
  if (screenRow >= source.rows) return { line: null };
  return { line: source.getLine(screenRow), grapheme: screenGraphemes(source.buffer, screenRow) };
}
