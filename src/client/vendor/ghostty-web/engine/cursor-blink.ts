// webtty (ADR 049, ADR 061), not from upstream.
// The cursor blink scanner (util): finds the sequences that set the blink while Ghostty's
// DEC mode 12 is ignored, carrying an unfinished one across output chunks.

// What sets the cursor blink while mode 12 is ignored: DECSCUSR (CSI Ps SP q), DECSTR
// (CSI ! p) and RIS (ESC c). The last two restore the default, as Ps 0 does.
const CURSOR_BLINK_SEQ = /\x1b(?:\[(\d*) q|\[!p|c)/g;
const CURSOR_BLINK_PREFIX = /^\x1b(?:\[(?:\d{0,3} ?|!)?)?$/;

/**
 * Scans output for the sequences that set the cursor blink while DEC mode 12 is
 * ignored, and returns the last one as a DECSCUSR Ps from 0 to 6 (DECSTR and RIS
 * as 0; undefined if none), plus the unfinished sequence at the end of the chunk to
 * pass back in as `carry` with the next one. Most chunks hold none of them and are
 * not scanned. (webtty, ADR 049: Ghostty ignores mode 12 when `cursor-style-blink`
 * is set, in its app's stream handler, which libghostty-vt does not include.)
 */
export function scanCursorBlink(
  data: string,
  carry: string = ''
): { ps: number | undefined; carry: string } {
  const text = carry + data;
  let ps: number | undefined;
  if (carry !== '' || text.includes(' q') || text.includes('!p') || text.includes('\x1bc')) {
    for (const match of text.matchAll(CURSOR_BLINK_SEQ)) {
      const value = match[1] === undefined || match[1] === '' ? 0 : Number(match[1]);
      if (value <= 6) ps = value;
    }
  }
  const esc = text.lastIndexOf('\x1b');
  const tail = esc >= 0 && text.length - esc <= 6 ? text.slice(esc) : '';
  return { ps, carry: CURSOR_BLINK_PREFIX.test(tail) ? tail : '' };
}
