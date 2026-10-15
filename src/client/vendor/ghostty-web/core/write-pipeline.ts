// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The write pipeline (controller): a write in its fixed order, the view kept on its text
// across it, a waiting clear at ground, the engine write, the synchronized update's timing,
// the replies, the focus-mode edge, the effects, the link cache, the alternate screen's
// scroll to the bottom and the echo render, plus clear screen and the reply drain (ADR 042,
// ADR 053, ADR 054, ADR 055, ADR 061, ADR 066, ADR 067); dispose() cancels the write
// callbacks still waiting (ADR 065).

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
  // The frames of the write callbacks not run yet
  private readonly callbackFrames = new Set<number>();

  /** `frames` runs a write's callback on the next frame. */
  constructor(
    private readonly host: WriteHost,
    private readonly frames: FrameScheduler = browserFrames,
  ) {}

  /** Writes output to the engine and runs every step after it, in order. */
  write(data: string | Uint8Array, callback?: () => void): void {
    const host = this.host;
    const engine = host.engine()!;
    // A view scrolled back stays on its text, as in Ghostty (`scroll-to-bottom =
    // no-output`): an app that redraws while working (a spinner, a status line) would
    // otherwise pull it down on every redraw. coder/ghostty-web scrolled to the bottom on
    // any output, calling it xterm.js' behaviour, though xterm.js keeps a scrolled view
    // too (webtty, ADR 066). A key or a paste still scrolls to the bottom. A view on a
    // selected find match is kept by the find step instead (ADR 055).
    const pinned = !host.findAnchored() && !engine.isAlternateScreen() && host.pinView();
    try {
      // A pinned write keeps Ghostty's viewport away from the view, and a view on a find
      // match moves back to it only in the find step: either paints on a frame
      if (pinned || host.findAnchored()) this.feed(data);
      else this.feedPainting(data);
    } finally {
      if (pinned) host.unpinView();
    }

    // A begin of the app's synchronized update restarts its time (webtty, ADR 067)
    host.wroteOutput(data);

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

    // The alternate screen has no scrollback to keep a view in, and its matches are its
    // own: output that is on it, or turned it on, shows its bottom, without a smooth
    // scroll's sub-line offset either (webtty, ADR 055, ADR 066)
    if (engine.isAlternateScreen()) host.scrollToBottom();

    // The callback runs on the next frame, after the render
    if (callback) this.runNextFrame(callback);

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

  /** Cancels the write callbacks still waiting for their frame (ADR 065). Calling it again does nothing. */
  dispose(): void {
    for (const id of this.callbackFrames) this.frames.cancelAnimationFrame(id);
    this.callbackFrames.clear();
  }

  /**
   * Feeds output, painting where the synchronized update a held frame waits for ends,
   * before the rest of the output begins the next one, as Ghostty's renderer wakes when an
   * update ends (webtty, ADR 067).
   */
  private feedPainting(data: string | Uint8Array): void {
    const at = this.host.syncPaintPoint(data);
    if (at < 0) {
      this.feed(data);
      return;
    }
    const split = (from: number, to?: number) =>
      typeof data === 'string' ? data.slice(from, to) : data.subarray(from, to);
    this.feed(split(0, at));
    try {
      this.host.paintUpdate();
    } finally {
      // A paint that throws must not cost the engine the rest of the output
      if (at < data.length) this.feed(split(at));
    }
  }

  /** The engine parses the VT stream, a waiting clear going in where it reaches ground. */
  private feed(data: string | Uint8Array): void {
    const engine = this.host.engine()!;
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
    engine.write(data);
  }

  /** Runs a write's callback on the next frame, remembered until then so dispose() can cancel it. */
  private runNextFrame(callback: () => void): void {
    const id = this.frames.requestAnimationFrame(() => {
      this.callbackFrames.delete(id);
      callback();
    });
    this.callbackFrames.add(id);
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
