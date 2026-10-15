// Spots the sequences that invalidate placed images (util + object, pure, ADR 032), in
// one string or across arbitrary chunk boundaries.

const ESC = '\x1b';

// Sequences after which any placed image no longer corresponds to what is on
// screen: erase display (2 = screen, 3 = screen + scrollback), alternate
// screen switches, and full reset. The emulator cannot tell us about overwrites,
// so these are the only points where placements are dropped implicitly.
const CLEARS_PLACEMENTS = new RegExp(`${ESC}\\[[23]J|${ESC}\\[\\?(?:1049|1047|47)[hl]|${ESC}c`);

/** Whether `text` holds a sequence after which placed images no longer match the screen. */
export function clearsPlacements(text: string): boolean {
  return CLEARS_PLACEMENTS.test(text);
}

// A sequence cut off at the end of a chunk: ESC, or ESC [ followed by parameter
// bytes but no final byte yet.
const INCOMPLETE = new RegExp(`${ESC}(?:\\[[0-9;?]{0,16})?$`);

/**
 * Finds clear sequences in text that arrives in arbitrary pieces. PTY output and
 * WebSocket frames can end anywhere, so `ESC [` in one piece and `2 J` in the next
 * are one sequence; the terminal reassembles them in its own parser, and this
 * keeps the unfinished tail between calls so the client sees them too.
 */
export class ControlScanner {
  private carry = '';

  /** Whether a sequence that invalidates placed images was completed. */
  scan(text: string): boolean {
    const s = this.carry + text;
    const tail = INCOMPLETE.exec(s);
    // Anything before the tail is complete, so it is scanned now; the tail
    // itself cannot match yet and is scanned again once it is finished.
    this.carry = tail ? tail[0] : '';
    return clearsPlacements(s);
  }
}
