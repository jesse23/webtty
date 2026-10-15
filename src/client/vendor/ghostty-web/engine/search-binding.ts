// webtty (ADR 055, ADR 061), not from upstream.
// The search binding (object): wraps one libghostty-vt search over the terminal, made
// while a needle is set. It is fed on content changes, stepped in time slices, and its
// matches are read into a wasm buffer grown as needed.

import type { EngineContext } from './engine-context';
import type { ScreenRange, SearchState } from './engine-types';
import type { GridRefs } from './grid-refs';
import type { OfficialLayout } from './official-layout';
import { clearSelectionStruct, selectionRange } from './selection-binding';

/** The scratch slots the search binding declares on the shared context. */
export function searchSlots(L: OfficialLayout) {
  return {
    searchBuf: [L.search.bufferSize, 8],
    searchSel: [L.selection.size, 8],
  } as const;
}

/** The names of the search binding's scratch slots. */
export type SearchSlot = keyof ReturnType<typeof searchSlots>;

/** Ghostty's search on one terminal (ADR 055); the view is webtty's, never moved. */
export class SearchBinding {
  private readonly ctx: EngineContext<SearchSlot>;
  private readonly refs: GridRefs;
  // The handle while a needle is set, the generation it last fed, and the wasm buffer
  // matches are read into.
  private search = 0;
  private fedGen = 0;
  private matchBuf = 0;
  private matchCap = 0;

  constructor(ctx: EngineContext<SearchSlot>, refs: GridRefs) {
    this.ctx = ctx;
    this.refs = refs;
  }

  /** Sets the needle; an empty one ends the search and frees it. */
  setSearch(needle: string): void {
    const { ex, at, L } = this.ctx;
    const S = L.search;
    if (!needle) {
      this.free();
      return;
    }
    if (!this.search) {
      this.search = this.ctx.vt.newHandle('search_new', (slot) =>
        ex.ghostty_search_new(0, slot, this.ctx.term)
      );
      // The view is webtty's own; Ghostty's viewport stays at the bottom
      this.ctx.dv().setInt32(at.u32, S.SCROLL_NONE, true);
      ex.ghostty_search_set(this.search, S.SELECT_SCROLL, at.u32);
    }
    const bytes = new TextEncoder().encode(needle);
    const buf = ex.ghostty_wasm_alloc(bytes.length);
    try {
      this.ctx.u8().set(bytes, buf);
      const dv = this.ctx.dv();
      dv.setUint32(at.str + L.string.ptr, buf, true);
      dv.setUint32(at.str + L.string.len, bytes.length, true);
      // An unchanged needle keeps its results
      ex.ghostty_search_set(this.search, S.NEEDLE, at.str);
    } finally {
      ex.ghostty_wasm_free(buf, bytes.length);
    }
    this.fedGen = 0;
  }

  /** Feeds new content and runs the search for up to `budgetMs`; true if it did work. */
  searchStep(budgetMs: number): boolean {
    const { ex, at, L } = this.ctx;
    const S = L.search;
    if (!this.search) return false;
    let worked = false;
    // Feeding is the only way the search sees output, resizes and resets
    if (this.fedGen !== this.ctx.generation) {
      ex.ghostty_search_feed(this.search);
      this.fedGen = this.ctx.generation;
      worked = true;
    }
    if (ex.ghostty_search_get(this.search, S.STATUS, at.u32) !== 0) return worked;
    let status = this.ctx.dv().getInt32(at.u32, true);
    const end = performance.now() + budgetMs;
    while (status !== S.COMPLETE && performance.now() < end) {
      if (status === S.FEED_REQUIRED) ex.ghostty_search_feed(this.search);
      else ex.ghostty_search_tick(this.search, 0);
      if (ex.ghostty_search_get(this.search, S.STATUS, at.u32) !== 0) break;
      status = this.ctx.dv().getInt32(at.u32, true);
      worked = true;
    }
    return worked;
  }

  /** Selects the next (older) or previous match; false without a search. */
  searchSelect(direction: 'next' | 'previous'): boolean {
    const S = this.ctx.L.search;
    if (!this.search) return false;
    const option = direction === 'next' ? S.SELECT_NEXT : S.SELECT_PREV;
    return this.ctx.ex.ghostty_search_set(this.search, option, 0) === 0;
  }

  /** The match count and the selected match's index. */
  searchState(): SearchState {
    const { ex, at, L } = this.ctx;
    const S = L.search;
    if (!this.search) return { total: 0, selected: null };
    const read = (data: number): number | null =>
      ex.ghostty_search_get(this.search, data, at.u32) === 0
        ? this.ctx.dv().getUint32(at.u32, true)
        : null;
    return { total: read(S.TOTAL_MATCHES) ?? 0, selected: read(S.SELECTED_INDEX) };
  }

  /** The selected match in screen cells, or null. */
  searchSelectedMatch(): ScreenRange | null {
    const { at, L } = this.ctx;
    if (!this.search) return null;
    clearSelectionStruct(this.ctx, at.searchSel);
    if (this.ctx.ex.ghostty_search_get(this.search, L.search.SELECTED_MATCH, at.searchSel) !== 0) {
      return null;
    }
    return selectionRange(this.refs, L, at.searchSel);
  }

  /** Every match as (startCol, startRow, endCol, endRow) screen cells, four per match. */
  searchMatches(): Int32Array {
    const { ex, at, L } = this.ctx;
    const S = L.search;
    const Sel = L.selection;
    if (!this.search) return new Int32Array(0);
    // Matches are read where they are, before anything changes the terminal; the
    // buffer is grown to the count Ghostty reports, then read again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const dv = this.ctx.dv();
      dv.setUint32(at.searchBuf + S.ptr, this.matchBuf, true);
      dv.setUint32(at.searchBuf + S.cap, this.matchCap, true);
      dv.setUint32(at.searchBuf + S.len, 0, true);
      for (let i = 0; i < this.matchCap; i++) {
        dv.setUint32(this.matchBuf + i * Sel.size + Sel.sizeField, Sel.size, true);
      }
      const rc = ex.ghostty_search_get(this.search, S.MATCHES, at.searchBuf);
      const len = this.ctx.dv().getUint32(at.searchBuf + S.len, true);
      if (rc === L.result.OUT_OF_SPACE && attempt === 0) {
        if (!this.growMatches(len)) return new Int32Array(0);
        continue;
      }
      if (rc !== 0) return new Int32Array(0);
      return this.readMatches(len);
    }
    return new Int32Array(0);
  }

  /** Ends the search: frees the handle and the match buffer. Safe to call again. */
  free(): void {
    const ex = this.ctx.ex;
    if (this.search) ex.ghostty_search_free(this.search);
    this.search = 0;
    if (this.matchBuf) ex.ghostty_wasm_free(this.matchBuf, this.matchCap * this.ctx.L.selection.size);
    this.matchBuf = 0;
    this.matchCap = 0;
  }

  /** Replaces the match buffer with room for `len` matches and more; false if out of memory. */
  private growMatches(len: number): boolean {
    const ex = this.ctx.ex;
    const size = this.ctx.L.selection.size;
    if (this.matchBuf) ex.ghostty_wasm_free(this.matchBuf, this.matchCap * size);
    // Room for the matches output adds before the next read
    this.matchCap = len + (len >> 2) + 16;
    this.matchBuf = ex.ghostty_wasm_alloc(this.matchCap * size);
    if (this.matchBuf) return true;
    this.matchCap = 0;
    return false;
  }

  /** The first `len` matches of the buffer in screen cells. */
  private readMatches(len: number): Int32Array {
    const Sel = this.ctx.L.selection;
    const out = new Int32Array(len * 4);
    for (let i = 0; i < len; i++) {
      const sel = this.matchBuf + i * Sel.size;
      const start = this.refs.screenCellOf(sel + Sel.start);
      const end = this.refs.screenCellOf(sel + Sel.end);
      // A match that has no screen point (none expected) is left at row -1
      out[i * 4] = start?.col ?? 0;
      out[i * 4 + 1] = start?.row ?? -1;
      out[i * 4 + 2] = end?.col ?? 0;
      out[i * 4 + 3] = end?.row ?? -1;
    }
    return out;
  }
}
