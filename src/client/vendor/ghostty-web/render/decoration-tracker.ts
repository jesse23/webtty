// webtty (ADR 043, ADR 055, ADR 061), not from upstream.
// The decoration tracker (object): what a frame draws over the cells' own colours (the
// selection, the search matches, the hovered link), kept in canvas rows next to what the
// rows were drawn with, so a frame repaints only the rows whose decorations changed.

import type { HighlightSpan, SearchHighlights } from '../search';
import { highlightRows, spansKey } from '../search';
import { type CellRange, moveRangeRows, sameRange } from './cell-range';
import type { FrameDecorations } from './renderable';
import { changeRow, shiftedRowKeys } from './row-band';

/** The selection as the renderer reads it, in viewport rows, not clamped to the viewport. */
export interface SelectionSource {
  hasSelection(): boolean;
  getSelectionRange(): CellRange | null;
}

/**
 * Holds the decorations to draw and the ones each canvas row was drawn with. They are
 * anchored to buffer lines like the canvas rows, so they follow a copied scroll.
 */
export class DecorationTracker {
  /** This frame's decorations, in canvas rows, as the cell painter reads them. */
  readonly frame: FrameDecorations = { selection: null, searchSpans: [], link: null };
  private selectionSource?: SelectionSource;
  // The selection the canvas rows were drawn with, in canvas rows (webtty, ADR 043)
  private drawnSelection: CellRange | null = null;
  // The hovered link's range (OSC 8 or regex), in viewport rows. The engine's
  // hyperlink_id is a 1-bit "has a link" flag, not an id, so the range is the only
  // thing that tells one link from another. (webtty)
  private hoveredLink: CellRange | null = null;
  // The link range the canvas rows were drawn with, in canvas rows (webtty, ADR 043)
  private drawnLink: CellRange | null = null;
  // The search matches (ADR 055), and the spans each canvas row was drawn with (as `spansKey`)
  private highlights: SearchHighlights | null = null;
  private drawnSearch: string[] = [];

  /** Sets where the selection is read from each frame. */
  setSelectionSource(source: SelectionSource): void {
    this.selectionSource = source;
  }

  /** Sets the search matches to highlight, or null for none. */
  setSearchHighlights(highlights: SearchHighlights | null): void {
    this.highlights = highlights;
  }

  /** Sets the hovered link's range in viewport rows, or null for none. */
  setHoveredLink(range: CellRange | null): void {
    this.hoveredLink = range;
  }

  /** Follows the canvas content moved by `shift` rows on a copied scroll of `total` rows. */
  shift(shift: number, total: number): void {
    this.drawnSelection = moveRangeRows(this.drawnSelection, shift);
    this.drawnLink = moveRangeRows(this.drawnLink, shift);
    this.drawnSearch = shiftedRowKeys(this.drawnSearch, shift, total);
  }

  /**
   * Sets this frame's decorations for viewport row 0 at canvas row `top`, and marks in
   * `state` the rows whose selection, search spans or link underline changed. `view` is
   * the viewport's whole line and `scrollbackLength` the lines above the screen.
   */
  mark(state: Uint8Array, top: number, view: number, cols: number, scrollbackLength: number): void {
    const total = state.length;
    const frame = this.frame;
    const selection = this.selectionSource?.hasSelection()
      ? this.selectionSource.getSelectionRange()
      : null;
    frame.selection = moveRangeRows(selection, top);
    if (!sameRange(frame.selection, this.drawnSelection)) {
      for (const range of [this.drawnSelection, frame.selection]) {
        if (!range) continue;
        const last = Math.min(range.endRow, total - 1);
        for (let k = Math.max(0, range.startRow); k <= last; k++) changeRow(state, k);
      }
    }
    this.drawnSelection = frame.selection;

    if (this.drawnSearch.length !== total) this.drawnSearch = new Array<string>(total).fill('');
    frame.searchSpans = this.searchSpans(top, total, view, cols, scrollbackLength);
    for (let k = 0; k < total; k++) {
      if (spansKey(frame.searchSpans[k]) !== this.drawnSearch[k]) changeRow(state, k);
    }

    // A link underline is drawn at viewport rows, which are other canvas rows after a
    // scroll: clear it where it was drawn and draw it where it is.
    frame.link = moveRangeRows(this.hoveredLink, top);
    if (!sameRange(frame.link, this.drawnLink)) {
      for (const range of [this.drawnLink, frame.link]) {
        if (!range) continue;
        for (let k = range.startRow; k <= range.endRow; k++) changeRow(state, k);
      }
    }
    this.drawnLink = frame.link;
  }

  /** Records the search spans the rows marked in `repainted` were drawn with. */
  repainted(repainted: Uint8Array): void {
    for (let k = 0; k < repainted.length; k++) {
      if (repainted[k]) this.drawnSearch[k] = spansKey(this.frame.searchSpans[k]);
    }
  }

  /** The search spans per canvas row (webtty, ADR 055). */
  private searchSpans(
    top: number,
    total: number,
    view: number,
    cols: number,
    scrollbackLength: number
  ): (HighlightSpan[] | undefined)[] {
    const spans = new Array<HighlightSpan[] | undefined>(total);
    if (!this.highlights) return spans;
    // Canvas row k shows screen row k - top plus the screen row at the viewport's top
    const toScreen = scrollbackLength - view - top;
    for (const [row, s] of highlightRows(this.highlights, toScreen, toScreen + total - 1, cols)) {
      spans[row - toScreen] = s;
    }
    return spans;
  }
}
