// webtty (ADR 050, ADR 057, ADR 061), not from upstream.
// The selection binding (object): Ghostty's word, line and command-output selection
// picked from a screen cell, and the selected text formatted as Ghostty copies it.
// Also the two helpers on a GhosttySelection struct the search binding shares.

import type { EngineContext } from './engine-context';
import type { ScreenCell, ScreenRange } from './engine-types';
import type { GridRefSlot, GridRefs } from './grid-refs';
import type { OfficialLayout } from './official-layout';

/** The scratch slots the selection binding declares on the shared context. */
export function selectionSlots(L: OfficialLayout) {
  return {
    sel: [L.selection.size, 8],
    selOpts: [
      Math.max(L.selection.word.size, L.selection.line.size, L.selection.format.size),
      8,
    ],
    outPtr: [4, 4],
    outLen: [4, 4],
  } as const;
}

/** The names of the selection binding's scratch slots. */
export type SelectionSlot = keyof ReturnType<typeof selectionSlots>;

/** Zeroes the GhosttySelection at `sel` and sets its size field. */
export function clearSelectionStruct(ctx: EngineContext, sel: number): void {
  const S = ctx.L.selection;
  ctx.u8().fill(0, sel, sel + S.size);
  ctx.dv().setUint32(sel + S.sizeField, S.size, true);
}

/** The screen range of the GhosttySelection at `sel`, or null if an end has no cell. */
export function selectionRange(refs: GridRefs, L: OfficialLayout, sel: number): ScreenRange | null {
  const start = refs.screenCellOf(sel + L.selection.start);
  const end = refs.screenCellOf(sel + L.selection.end);
  return start && end ? { start, end } : null;
}

/** The options struct of a `select_*` call: sized, with one grid reference. */
interface SelectOptions {
  size: number;
  sizeField: number;
  ref: number;
}

/** Ghostty's selection rules on one terminal (ADR 050, ADR 057). */
export class SelectionBinding {
  // The grid refs' `gridRef` slot holds the cell `selectOutput` starts from.
  private readonly ctx: EngineContext<SelectionSlot | GridRefSlot>;
  private readonly refs: GridRefs;

  constructor(ctx: EngineContext<SelectionSlot | GridRefSlot>, refs: GridRefs) {
    this.ctx = ctx;
    this.refs = refs;
  }

  /** The word at `cell`, by Ghostty's word boundaries, soft wraps followed. */
  selectWord(cell: ScreenCell): ScreenRange | null {
    return this.selectAt(this.ctx.L.selection.word, cell, (opts, out) =>
      this.ctx.ex.ghostty_terminal_select_word(this.ctx.term, opts, out)
    );
  }

  /** The line at `cell`, soft wraps followed, outer whitespace left out. */
  selectLine(cell: ScreenCell): ScreenRange | null {
    return this.selectAt(this.ctx.L.selection.line, cell, (opts, out) =>
      this.ctx.ex.ghostty_terminal_select_line(this.ctx.term, opts, out)
    );
  }

  /** The output of the command at `cell` (OSC 133 marks), or null elsewhere. */
  selectOutput(cell: ScreenCell): ScreenRange | null {
    const { at, L } = this.ctx;
    this.ctx.info();
    if (!this.refs.screenRef(cell, at.gridRef)) return null;
    clearSelectionStruct(this.ctx, at.sel);
    if (this.ctx.ex.ghostty_terminal_select_output(this.ctx.term, at.gridRef, at.sel) !== 0) {
      return null;
    }
    return selectionRange(this.refs, L, at.sel);
  }

  /** The text between two screen cells, as Ghostty copies it. */
  selectionText(start: ScreenCell, end: ScreenCell): string {
    const { ex, at, L } = this.ctx;
    const S = L.selection;
    const F = S.format;
    this.ctx.info();
    // Rows that left history, or a selection made before a resize, are clamped.
    const last = this.ctx.sbRows + this.ctx.rows - 1;
    const clamp = (c: ScreenCell): ScreenCell => ({
      col: Math.max(0, Math.min(c.col, this.ctx.cols - 1)),
      row: Math.max(0, Math.min(c.row, last)),
    });
    clearSelectionStruct(this.ctx, at.sel);
    if (!this.refs.screenRef(clamp(start), at.sel + S.start)) return '';
    if (!this.refs.screenRef(clamp(end), at.sel + S.end)) return '';
    this.ctx.u8().fill(0, at.selOpts, at.selOpts + F.size);
    const dv = this.ctx.dv();
    dv.setUint32(at.selOpts + F.sizeField, F.size, true);
    dv.setInt32(at.selOpts + F.emit, S.PLAIN, true);
    // Ghostty's copy: soft-wrapped rows joined, trailing whitespace trimmed.
    dv.setUint8(at.selOpts + F.unwrap, 1);
    dv.setUint8(at.selOpts + F.trim, 1);
    dv.setUint32(at.selOpts + F.selection, at.sel, true);
    dv.setUint32(at.outPtr, 0, true);
    dv.setUint32(at.outLen, 0, true);
    const rc = ex.ghostty_terminal_selection_format_alloc(
      this.ctx.term,
      0,
      at.selOpts,
      at.outPtr,
      at.outLen
    );
    const ptr = this.ctx.dv().getUint32(at.outPtr, true);
    const len = this.ctx.dv().getUint32(at.outLen, true);
    if (rc !== 0 || !ptr) return '';
    const text = new TextDecoder().decode(this.ctx.u8().slice(ptr, ptr + len));
    ex.ghostty_free(0, ptr, len);
    return text;
  }

  /**
   * Runs a `select_*` call whose options are a sized struct with one grid reference,
   * set to `cell`, and returns the selection it derives in screen cells.
   */
  private selectAt(
    options: SelectOptions,
    cell: ScreenCell,
    call: (options: number, outSelection: number) => number
  ): ScreenRange | null {
    const { at, L } = this.ctx;
    this.ctx.info();
    this.ctx.u8().fill(0, at.selOpts, at.selOpts + options.size);
    this.ctx.dv().setUint32(at.selOpts + options.sizeField, options.size, true);
    if (!this.refs.screenRef(cell, at.selOpts + options.ref)) return null;
    clearSelectionStruct(this.ctx, at.sel);
    if (call(at.selOpts, at.sel) !== 0) return null;
    return selectionRange(this.refs, L, at.sel);
  }
}
