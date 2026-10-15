// webtty (ADR 043, ADR 047, ADR 061), not from upstream.
// The scrollback page cache (object): rows above the active screen, read a page at a time
// through a second render state and kept until the content changes, so scrolling only
// records an offset and serves rows from the active copy and this cache.

import type { EngineContext } from './engine-context';
import type { RenderState } from './render-state';
import type { RowRef } from './row-ref';

/** At most this many pages of scrollback rows stay cached per generation. */
export const PAGE_CACHE_SIZE = 16;

/**
 * Rows by absolute index, 0 being the oldest scrollback row: active rows come from the
 * render state's copy, scrollback rows from pages of one screen height, least recently
 * used dropped first.
 */
export class ScrollbackPages {
  private readonly ctx: EngineContext;
  private readonly render: RenderState;
  private pageRs = 0;
  // Scrollback rows, keyed by the absolute row their page starts at.
  private readonly pages = new Map<number, RowRef[]>();
  private pageGen = 0;

  constructor(ctx: EngineContext, render: RenderState) {
    this.ctx = ctx;
    this.render = render;
  }

  /** A row by absolute index; call `render.refresh()` first. */
  rowAt(abs: number): RowRef {
    const sbRows = this.ctx.sbRows;
    if (abs >= sbRows) return this.render.viewRow(abs - sbRows);
    return this.scrollbackRow(abs);
  }

  /**
   * Scrollback row `abs` (`abs` < the scrollback length), read with the page of `rows`
   * rows holding it on a miss: moves Ghostty's viewport there, reads every row with
   * CELLS_RAW, and moves it back to the bottom. The primary state has already been
   * refreshed at this generation (callers refresh first), so it has captured every
   * pending dirty bit before the second state's update consumes the terminal's dirty
   * state. The second state cannot trust dirty bits the primary has cleared, so it is
   * recreated whenever the content has changed, and every miss rebuilds every row it
   * reads. Scrolling changes no row, so the state and the pages are kept.
   */
  scrollbackRow(abs: number): RowRef {
    const ctx = this.ctx;
    const ex = ctx.ex;
    // abs < S, so the page starts in scrollback: scroll_viewport ROW n snaps to the
    // active screen only for n >= S. A page may run on into active rows; rowAt
    // serves those from the primary copy.
    const start = Math.floor(abs / ctx.rows) * ctx.rows;
    if (this.pageGen !== ctx.generation) {
      if (this.pageRs) ex.ghostty_render_state_free(this.pageRs);
      this.pageRs = ctx.vt.newHandle('render_state_new', (slot) =>
        ex.ghostty_render_state_new(0, slot)
      );
      this.pages.clear();
      this.pageGen = ctx.generation;
    }
    let page = this.pages.get(start);
    if (page) {
      this.pages.delete(start);
      this.pages.set(start, page);
      return page[abs - start];
    }

    ctx.scrollViewport(ctx.L.scroll.ROW, start);
    try {
      const rc = ex.ghostty_render_state_update(this.pageRs, ctx.term);
      if (rc !== 0) throw new Error(`libghostty-vt render_state_update failed: ${rc}`);
      page = this.render.decodePage(this.pageRs);
    } finally {
      ctx.scrollViewport(ctx.L.scroll.BOTTOM, 0);
    }
    this.pages.set(start, page);
    if (this.pages.size > PAGE_CACHE_SIZE) {
      const oldest = this.pages.keys().next().value;
      if (oldest !== undefined) this.pages.delete(oldest);
    }
    return page[abs - start];
  }

  /** Frees the second render state; the cache is dropped with it. */
  free(): void {
    if (this.pageRs) this.ctx.ex.ghostty_render_state_free(this.pageRs);
    this.pageRs = 0;
    this.pages.clear();
  }
}
