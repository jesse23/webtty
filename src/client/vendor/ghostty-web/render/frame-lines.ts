// webtty (ADR 042, ADR 061), not from upstream.
// One frame's row reader (util): the viewport read once and served as row slices, so a
// frame never copies and parses the whole viewport per row.

import type { GhosttyCell } from '../engine/cell-types';
import type { IRenderable } from './renderable';

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
