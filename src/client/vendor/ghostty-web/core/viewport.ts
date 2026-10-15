// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The view's position in the scrollback (object): `y` lines back from the bottom, moved
// only within the scrollback, each move announced and the scrollbar shown (ADR 061), and
// kept on its text across output with Ghostty's viewport pin (ADR 066).

import type { GhosttyTerminal } from '../engine/engine-types';
import type { ViewportHost } from './host-types';

/** The engine calls that keep a view on its text across a write (ADR 066). */
export type ViewPinEngine = Pick<GhosttyTerminal, 'pinViewport' | 'unpinViewport'>;

/** Where the view is: `y` = 0 shows the bottom screen, `y` > 0 is scrolled into history. */
export class Viewport {
  /**
   * Lines scrolled back from the bottom; fractional while smooth scrolling. Set directly,
   * it moves the view without an announcement, as Terminal's `viewportY` always has.
   */
  y = 0;
  /** Rows the pinned row is above the view's top row: 1 while part of it shows, else 0. */
  private pinnedAbove = 0;

  constructor(private readonly host: ViewportHost) {}

  /** Scrolls by `amount` lines: negative is up into history, positive down. */
  scrollLines(amount: number): void {
    const scrollbackLength = this.host.getScrollbackLength();
    this.moveTo(Math.max(0, Math.min(scrollbackLength, this.y - amount)), scrollbackLength);
  }

  /** Scrolls to `line` lines back from the bottom, clamped to the scrollback. */
  scrollToLine(line: number): void {
    const scrollbackLength = this.host.getScrollbackLength();
    this.moveTo(Math.max(0, Math.min(scrollbackLength, line)), scrollbackLength);
  }

  /**
   * Scrolls to the bottom, the current output. Announced even from line 0 while part of the
   * row above shows, so the embedder drops its sub-line offset. (webtty, ADR 066)
   */
  scrollToBottom(): void {
    if (this.y === 0 && !this.host.partRowShown()) return;
    this.y = 0;
    this.host.scrolled(0);
    if (this.host.getScrollbackLength() > 0) this.host.showScrollbar();
  }

  /**
   * Before a write: pins Ghostty's viewport on the top row in view, so the write moves it
   * with its text (`scroll-to-bottom = no-output`, Ghostty's default; webtty, ADR 066).
   * While the renderer shows part of the row above the view (a smooth scroll's sub-line
   * offset), that row is pinned: it is in view, and a pin on the active screen would follow
   * the output. Returns false, pinning nothing, for a view at the bottom, which follows the
   * output.
   */
  pin(engine: ViewPinEngine): boolean {
    const line = Math.floor(this.y);
    const partRow = this.host.partRowShown();
    if (line === 0 && !partRow) return false;
    const top = this.host.getScrollbackLength() - line;
    this.pinnedAbove = partRow && top > 0 ? 1 : 0;
    engine.pinViewport(top - this.pinnedAbove);
    return true;
  }

  /**
   * After the write: the view goes where Ghostty moved the pinned row, which keeps its text
   * through new lines, rows pruned at the scrollback limit and a cleared scrollback. Not a
   * scroll the user made, so it is not announced and shows no scrollbar. (webtty, ADR 066)
   */
  unpin(engine: ViewPinEngine): void {
    const row = engine.unpinViewport();
    const scrollback = this.host.getScrollbackLength();
    const fraction = this.y - Math.floor(this.y);
    const y = scrollback - row - this.pinnedAbove + fraction;
    this.y = Math.max(0, Math.min(scrollback, y));
  }

  /**
   * Ghostty's `jump_to_prompt`: moves by `delta` OSC 133 prompts (negative is up), the
   * prompt landing as the top row; nothing without marks or past the last one. (webtty,
   * ADR 057)
   */
  jumpToPrompt(delta: number, engine: Pick<GhosttyTerminal, 'promptJumpRow'>): void {
    const scrollback = this.host.getScrollbackLength();
    const top = scrollback - Math.floor(this.y);
    const row = engine.promptJumpRow(top, delta);
    if (row !== top) this.scrollToLine(scrollback - row);
  }

  private moveTo(y: number, scrollbackLength: number): void {
    if (y === this.y) return;
    this.y = y;
    this.host.scrolled(y);
    if (scrollbackLength > 0) this.host.showScrollbar();
  }
}
