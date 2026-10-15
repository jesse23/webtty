// webtty (ADR 055, ADR 061), not from upstream.
// Find in the scrollback (controller): the needle on libghostty-vt's search, stepped a few
// milliseconds a frame by the render loop, its matches handed to the renderer, and the
// view taken to and kept on the selected match (ADR 055). Moved out of terminal.ts (ADR 061).

import type { SearchState } from '../engine/engine-types';
import { type FindAnchor, keptViewportY, viewportYToShow } from '../search';
import type { FindHost } from './host-types';
import { FIND_READ_BACKOFF, FIND_STEP_MS } from './terminal-constants';

/** The browser's monotonic clock, read when called. */
const performanceNow = (): number => performance.now();

/**
 * Ghostty's `search`, `navigate_search` and `end_search` on one terminal. The search runs
 * in `step`, which the render loop calls before each render.
 */
export class FindController {
  // The needle, '' with no search open
  private needle = '';
  // Whether the matches need reading again, and when they may be
  private stale = false;
  private readAt = 0;
  // Where the selected match was when the view last followed it
  private anchor: FindAnchor | null = null;
  // The count last reported
  private state: SearchState = { total: 0, selected: null };

  /** `now` times a read of the matches, for its backoff; `performance.now()` by default. */
  constructor(
    private readonly host: FindHost,
    private readonly now: () => number = performanceNow,
  ) {}

  /** Whether a search is open. */
  get finding(): boolean {
    return this.needle !== '';
  }

  /**
   * Whether the view follows a selected match: output then keeps the view on its rows
   * instead of scrolling to the bottom.
   */
  get anchored(): boolean {
    return this.anchor !== null;
  }

  /** Starts a search for `needle`, every match highlighted and none selected; '' ends it. */
  find(needle: string): void {
    this.needle = needle;
    this.host.engine()?.setSearch(needle);
    this.anchor = null;
    this.stale = !!needle;
    this.readAt = 0;
    this.host.highlight(null);
    this.report();
  }

  /** Sets the needle again on the new engine Terminal.reset() made. */
  restart(): void {
    if (this.needle) this.find(this.needle);
  }

  /**
   * Selects the next match (toward older output) or the previous one, and scrolls to it
   * if none of its rows is in view. False with no search open.
   */
  select(direction: 'next' | 'previous'): boolean {
    const engine = this.host.engine();
    if (!this.needle || !engine) return false;
    engine.searchSelect(direction);
    const match = engine.searchSelectedMatch();
    if (match) {
      const y = viewportYToShow(
        match,
        this.host.getScrollbackLength(),
        this.host.viewportY(),
        this.host.rows(),
      );
      if (y !== null) this.host.scrollToLine(y);
    }
    this.anchor = match && { row: match.start.row, scrollback: this.host.getScrollbackLength() };
    this.stale = true;
    this.readAt = 0;
    this.report();
    return true;
  }

  /**
   * Runs the search for a few milliseconds and, when its results changed, gives the
   * renderer the matches. Reading them takes a few milliseconds with tens of thousands,
   * so while output keeps changing them they are read at most every ten times the last
   * read took. A scrolled view on a selected match is kept on its rows.
   */
  step(now: number): void {
    const engine = this.host.engine();
    if (!this.needle || !engine) return;
    if (engine.searchStep(FIND_STEP_MS)) {
      this.stale = true;
      this.report();
    }
    if (!this.stale || now < this.readAt) return;
    const started = this.now();
    const selected = engine.searchSelectedMatch();
    this.host.highlight({ matches: engine.searchMatches(), selected });
    this.stale = false;
    this.readAt = now + (this.now() - started) * FIND_READ_BACKOFF;
    const scrollback = this.host.getScrollbackLength();
    const viewportY = this.host.viewportY();
    if (selected && this.anchor && viewportY > 0) {
      this.host.scrollToLine(keptViewportY(viewportY, this.anchor, selected.start.row, scrollback));
    }
    this.anchor = selected && { row: selected.start.row, scrollback };
  }

  /** Reports through the host if the count or the selected match changed. */
  private report(): void {
    const state = this.host.engine()?.searchState() ?? { total: 0, selected: null };
    if (state.total === this.state.total && state.selected === this.state.selected) return;
    this.state = state;
    this.host.changed(state);
  }
}
