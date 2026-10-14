// webtty (ADR 042, ADR 050, ADR 061), not from upstream.
// Single-cell lookups through Ghostty grid references (object): points resolved to grid
// refs, grid refs back to screen cells, row wrap flags and OSC 8 hyperlink URIs. The
// selection and search bindings use it to cross between screen cells and grid refs.

import type { EngineContext } from './engine-context';
import type { ScreenCell } from './engine-types';
import type { OfficialLayout } from './official-layout';

/** The scratch slots the grid refs declare on the shared context. */
export function gridRefSlots(L: OfficialLayout) {
  return {
    point: [L.point.size, 8],
    gridRef: [L.gridRef.size, 8],
    coord: [8, 8],
    row64: [8, 8],
  } as const;
}

/** The names of the grid refs' scratch slots. */
export type GridRefSlot = keyof ReturnType<typeof gridRefSlots>;

/** Room for most hyperlink URIs; a longer one is read again at the size Ghostty reports. */
const HYPERLINK_FIRST_CAP = 256;

/** Grid-ref reads on one terminal (ADR 042): a point in, a cell, flag or URI out. */
export class GridRefs {
  private readonly ctx: EngineContext<GridRefSlot>;

  constructor(ctx: EngineContext<GridRefSlot>) {
    this.ctx = ctx;
  }

  /** Resolves a point to a grid reference at `out` (by default the `gridRef` slot). */
  gridRef(tag: number, x: number, y: number, out: number = this.ctx.at.gridRef): boolean {
    const { L, at } = this.ctx;
    const P = L.point;
    this.ctx.u8().fill(0, at.point, at.point + P.size);
    const dv = this.ctx.dv();
    dv.setInt32(at.point + P.tag, tag, true);
    dv.setUint16(at.point + P.value + P.x, x, true);
    dv.setUint32(at.point + P.value + P.y, y, true);
    this.ctx.u8().fill(0, out, out + L.gridRef.size);
    dv.setUint32(out + L.gridRef.sizeField, L.gridRef.size, true);
    return this.ctx.ex.ghostty_terminal_grid_ref(this.ctx.term, at.point, out) === 0;
  }

  /** The grid reference of a screen cell at `out`; false off the grid. */
  screenRef(cell: ScreenCell, out: number): boolean {
    if (cell.col < 0 || cell.col >= this.ctx.cols || cell.row < 0) return false;
    return this.gridRef(this.ctx.L.point.SCREEN, cell.col, cell.row, out);
  }

  /** The screen cell of the grid reference at `ref`, or null if it has none. */
  screenCellOf(ref: number): ScreenCell | null {
    const { at, L } = this.ctx;
    const P = L.point;
    const rc = this.ctx.ex.ghostty_terminal_point_from_grid_ref(
      this.ctx.term,
      ref,
      P.SCREEN,
      at.coord
    );
    if (rc !== 0) return null;
    const dv = this.ctx.dv();
    return { col: dv.getUint16(at.coord + P.x, true), row: dv.getUint32(at.coord + P.y, true) };
  }

  /** Whether active row `row` continues on the next row (a soft wrap). */
  isRowWrapped(row: number): boolean {
    if (row < 0 || row >= this.ctx.rows) return false;
    const { ex, at, L } = this.ctx;
    if (!this.gridRef(L.point.ACTIVE, 0, row)) return false;
    if (ex.ghostty_grid_ref_row(at.gridRef, at.row64) !== 0) return false;
    const rowValue = this.ctx.dv().getBigUint64(at.row64, true);
    if (ex.ghostty_row_get(rowValue, L.rowWrapContinuation, at.u8) !== 0) return false;
    return this.ctx.u8()[at.u8] !== 0;
  }

  /** The OSC 8 URI of the cell at point (`tag`, `x`, `y`), or null if it has none. */
  hyperlinkAt(tag: number, x: number, y: number): string | null {
    if (x < 0 || x >= this.ctx.cols || y < 0) return null;
    const { ex, at, L } = this.ctx;
    if (!this.gridRef(tag, x, y)) return null;
    // Most URIs fit; a longer one (Ghostty keeps OSC 8 URIs up to about 2 KiB) is
    // read again with the size Ghostty reports.
    let cap = HYPERLINK_FIRST_CAP;
    for (let attempt = 0; attempt < 2; attempt++) {
      const size = cap;
      const buf = ex.ghostty_wasm_alloc(size);
      try {
        const rc = ex.ghostty_grid_ref_hyperlink_uri(at.gridRef, buf, size, at.u32);
        const n = this.ctx.dv().getUint32(at.u32, true);
        if (rc === L.result.OUT_OF_SPACE) {
          cap = n;
          continue;
        }
        if (rc !== 0 || n === 0) return null;
        return new TextDecoder().decode(this.ctx.u8().slice(buf, buf + n));
      } finally {
        ex.ghostty_wasm_free(buf, size);
      }
    }
    return null;
  }
}
