// Cell and device-pixel geometry of placed images (util, pure, ADR 032): the whole-pixel
// cell size Ghostty reports, the per-axis CSS-to-device scale, and how many cells an
// image covers.

import { type KittyKeys, num } from './apc-command';

/**
 * A cell's size in whole device pixels. Ghostty reports it to programs (CSI 16t,
 * from the vendored `deviceCellPixels`, which computes the same) and they size
 * frames as cols x this, so it has to be an integer even though the CSS cell size
 * (and devicePixelRatio, e.g. 1.25 or 1.5 on Windows) is not.
 */
export function deviceCellSize(cssCell: number, dpr: number): number {
  return Math.max(1, Math.round(cssCell * dpr));
}

/**
 * Device pixels per CSS pixel along one axis, derived from the whole-pixel cell
 * size rather than from devicePixelRatio directly. A frame of `cols` cells is
 * `cols * deviceCellSize` pixels wide; dividing by this scale draws it exactly
 * `cols * cssCell` CSS pixels wide, however the rounding fell. Dividing by the
 * raw devicePixelRatio would drift by up to half a pixel per column, which
 * leaves the image off the terminal grid at fractional scales.
 */
export function axisScale(cssCell: number, dpr: number): number {
  return cssCell > 0 ? deviceCellSize(cssCell, dpr) / cssCell : dpr;
}

/** The cells an image covers, as `cellSpan` computes them. */
export interface CellSpan {
  cols: number;
  rows: number;
}

/**
 * How many cells an image covers. `c` / `r` win when given; when only one is
 * given the other follows from the aspect ratio; with neither, the image is
 * shown at natural size. `region` is the size in CSS pixels of the part of the
 * image being shown (the whole image, or the `w` x `h` source rectangle already
 * converted from device pixels by the caller).
 */
export function cellSpan(
  keys: KittyKeys,
  region: { width: number; height: number },
  cellWidth: number,
  cellHeight: number,
): CellSpan {
  const c = num(keys, 'c');
  const r = num(keys, 'r');
  const sw = region.width;
  const sh = region.height;
  if (c && r) return { cols: c, rows: r };
  if (c) return { cols: c, rows: cellsFor((c * cellWidth * sh) / sw, cellHeight) };
  if (r) return { cols: cellsFor((r * cellHeight * sw) / sh, cellWidth), rows: r };
  return { cols: cellsFor(sw, cellWidth), rows: cellsFor(sh, cellHeight) };
}

// Whole cells needed for `px`. A size that is exactly N cells, converted from
// device to CSS pixels, can come out as N + a rounding error, which a plain
// ceil turns into N + 1: the tolerance is far below any real fraction of a
// cell.
function cellsFor(px: number, cell: number): number {
  return Math.max(1, Math.ceil(px / cell - 1e-6));
}
