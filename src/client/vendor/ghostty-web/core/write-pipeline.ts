// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The write pipeline (controller): a write in its fixed order, a waiting clear at ground,
// the engine write, the replies, the focus-mode edge, the effects, the link cache, the
// auto-scroll and the echo render, plus clear screen and the reply drain (ADR 042, ADR 053,
// ADR 054, ADR 055, ADR 061).

import type { FrameScheduler, WriteHost } from './host-types';
import { browserFrames } from './render-loop';

/**
 * Feeds output to the engine. Selection is not cleared on a write: most terminals keep it
 * when data arrives; clicking or typing clears it.
 */
export class WritePipeline {
  // A clearScreen waiting for the output to reach ground (webtty, ADR 054)
  private pendingClear = false;
  // Input was sent: the next write renders at once, for its echo
  private awaitingEcho = false;

  /** `frames` runs a write's callback on the next frame. */
  constructor(
    private readonly host: WriteHost,
    private readonly frames: Pick<FrameScheduler, 'requestAnimationFrame'> = browserFrames,
  ) {}

  /** Writes output to the engine and runs every step after it, in order. */
  write(data: string | Uint8Array, callback?: () => void): void {
    const host = this.host;
    const engine = host.engine()!;
    // A waiting clear goes in where the output reaches ground (webtty, ADR 054)
    if (this.pendingClear) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const n = engine.writeUntilGround(bytes);
      if (n !== null) {
        this.pendingClear = false;
        this.writeClear();
      }
      data = bytes.subarray(n ?? bytes.length);
    }

    // The engine parses the VT stream
    engine.write(data);

    // Replies the output asked for (DSR and the like) go back to the PTY
    this.drainReplies();

    // Ghostty reports the focus when the app turns mode 1004 on (webtty, ADR 053)
    host.followFocusMode();

    // Bell, title (OSC 0/2), clipboard writes (OSC 52) and desktop notifications (OSC 9,
    // OSC 777) as Ghostty reported them (webtty, ADR 042, ADR 052, ADR 056)
    const effects = engine.readEffects();
    if (effects.bell) host.bell();
    if (effects.title !== null) host.title(effects.title);
    if (effects.clipboard !== null) host.clipboardWrite(effects.clipboard);
    for (const n of effects.notifications) host.notify(n);

    // The content changed, so cached links are stale
    host.outputChanged();

    // Auto-scroll to bottom on new output (xterm.js behavior), except while the
    // view is on a selected match: the find step keeps it on its rows. The alternate
    // screen has no scrollback to keep a view in, and its matches are its own (webtty, ADR 055)
    if (host.viewportY() !== 0 && (!host.findAnchored() || engine.isAlternateScreen())) {
      host.scrollToBottom();
    }

    // The callback runs on the next frame, after the render
    if (callback) this.frames.requestAnimationFrame(callback);

    if (this.awaitingEcho) {
      this.awaitingEcho = false;
      host.renderEcho();
    }
  }

  /**
   * The erasing of Ghostty's `clear_screen`, written to the terminal once the output
   * reaches ground, so it never cuts a sequence the output left unfinished (ADR 054).
   */
  clearAtGround(): void {
    this.pendingClear = true;
    this.write(new Uint8Array(0));
  }

  /** Renders the next write at once: input was sent and its echo should show. */
  awaitEcho(): void {
    this.awaitingEcho = true;
  }

  /** Drops a waiting clear: it was for an engine reset() replaced (ADR 054). */
  reset(): void {
    this.pendingClear = false;
  }

  /**
   * Sends every reply the engine has queued to the PTY through onData: DSR 6 (cursor
   * position), DSR 5 (status), size reports and the like. Shells such as nushell hang
   * without them. One write can hold several queries, so all are read.
   */
  drainReplies(): void {
    const engine = this.host.engine();
    if (!engine) return;
    while (true) {
      const response = engine.readResponse();
      if (response === null) break;
      this.host.send(response);
    }
  }

  /** Clears at a shell prompt (FF sent for the redraw), elsewhere the rows above the cursor. */
  private writeClear(): void {
    const engine = this.host.engine()!;
    // The output before it may have turned the alternate screen on
    if (engine.isAlternateScreen()) return;
    if (engine.cursorAtPrompt()) {
      // ED 2 at a prompt moves the screen into the scrollback, so ED 3 comes after it
      engine.write('\x1b[2J\x1b[3J');
      if (!this.host.disableStdin()) this.host.send('\x0c');
    } else {
      const y = engine.getCursor().y;
      engine.write(`${y > 0 ? `\x1b[${y}S\x1b[${y}A` : ''}\x1b[3J`);
    }
  }
}
