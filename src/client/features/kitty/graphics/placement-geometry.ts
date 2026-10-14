// The arithmetic of a placement (util, pure, ADR 032): the record a command makes at the
// cursor, how far the cursor moves past it, and the rectangle it is drawn into.

import { type KittyKeys, num } from '../protocol/apc-command';
import { cellSpan } from '../protocol/cell-geometry';
import { KittyError } from './kitty-error';
import type { CellSize, Scale } from './kitty-terminal';
import type { Placement } from './placements';

/** A size in pixels; 0 x 0 when only the decode can tell. */
interface Size {
  width: number;
  height: number;
}

/**
 * Refuses a placement that would have to move the cursor (C=0, the default) by a size
 * nobody knows yet: only a decode can tell a compressed PNG's size, and the cursor has to
 * move at this exact point in the stream.
 */
export function assertCursorMovable(keys: KittyKeys, size: Size): void {
  if (num(keys, 'C') === 1 || (size.width && size.height)) return;
  throw new KittyError('EINVAL', 'size of a compressed PNG is unknown until decoded: use C=1');
}

/** The placement a command makes for `imageId` at the cursor cell `at`. */
export function placementAt(
  keys: KittyKeys,
  imageId: number,
  at: { absRow: number; col: number },
  scale: Scale,
): Placement {
  const p: Placement = {
    imageId,
    placementId: num(keys, 'p'),
    absRow: at.absRow,
    col: at.col,
    srcX: num(keys, 'x'),
    srcY: num(keys, 'y'),
    srcW: num(keys, 'w'),
    srcH: num(keys, 'h'),
    offX: num(keys, 'X'),
    offY: num(keys, 'Y'),
    scale,
  };
  if (keys.c !== undefined) p.cols = num(keys, 'c');
  if (keys.r !== undefined) p.rows = num(keys, 'r');
  return p;
}

/**
 * What to write so the cursor ends past the image, as C=0 (the default) asks: on its last
 * row, right of its last column. The WASM cannot know an image took space, so it is
 * moved by hand. Null for C=1.
 */
export function cursorAdvance(
  keys: KittyKeys,
  p: Placement,
  image: Size,
  cell: CellSize,
): string | null {
  if (num(keys, 'C') === 1) return null;
  // The shown region is the source rectangle when given; `w` / `h` are
  // device pixels like the image, so they convert with the same scale.
  const region = {
    width: (p.srcW || Math.max(1, image.width - p.srcX)) / p.scale.x,
    height: (p.srcH || Math.max(1, image.height - p.srcY)) / p.scale.y,
  };
  const span = cellSpan(keys, region, cell.width, cell.height);
  return `${'\n'.repeat(span.rows - 1)}\x1b[${p.col + span.cols + 1}G`;
}

/** A placement's source rectangle in the bitmap and destination box on the overlay. */
export interface DrawRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  x: number;
  y: number;
  dw: number;
  dh: number;
}

/**
 * Where `p` is drawn, in CSS pixels from the overlay's top left. `topRow` is the absolute
 * row at the top of the viewport and `offset` the smooth-scroll offset: viewport row 0
 * starts that far below the canvas top (ADR 043).
 */
export function drawRect(
  p: Placement,
  bitmap: Size,
  cell: CellSize,
  topRow: number,
  offset: number,
): DrawRect {
  const sx = p.srcX;
  const sy = p.srcY;
  const sw = p.srcW || bitmap.width - sx;
  const sh = p.srcH || bitmap.height - sy;
  const span =
    p.cols !== undefined || p.rows !== undefined
      ? cellSpan(
          { c: String(p.cols ?? 0), r: String(p.rows ?? 0) },
          { width: sw / p.scale.x, height: sh / p.scale.y },
          cell.width,
          cell.height,
        )
      : null;
  const dw = span ? span.cols * cell.width : sw / p.scale.x;
  const dh = span ? span.rows * cell.height : sh / p.scale.y;
  const x = p.col * cell.width + p.offX / p.scale.x;
  const y = (p.absRow - topRow) * cell.height + p.offY / p.scale.y + offset;
  return { sx, sy, sw, sh, x, y, dw, dh };
}
