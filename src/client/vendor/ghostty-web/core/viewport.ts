// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The view's position in the scrollback (object): `y` lines back from the bottom, moved
// only within the scrollback, each move announced and the scrollbar shown (ADR 061).

import type { GhosttyTerminal } from '../engine/engine-types';
import type { ViewportHost } from './host-types';

/** Where the view is: `y` = 0 shows the bottom screen, `y` > 0 is scrolled into history. */
export class Viewport {
  /**
   * Lines scrolled back from the bottom; fractional while smooth scrolling. Set directly,
   * it moves the view without an announcement, as Terminal's `viewportY` always has.
   */
  y = 0;

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

  /** Scrolls to the bottom, the current output. */
  scrollToBottom(): void {
    if (this.y === 0) return;
    this.y = 0;
    this.host.scrolled(0);
    if (this.host.getScrollbackLength() > 0) this.host.showScrollbar();
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
