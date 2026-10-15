// webtty (ADR 067), not from upstream.
// The synchronized-update scanner (util): finds where the app begins a synchronized update
// (`CSI ? 2026 h`, alone or among other modes) in output, carrying an unfinished sequence
// across output chunks, as the cursor blink scanner does (engine/cursor-blink.ts).

/** A DEC private mode set whose modes include 2026. */
const SYNC_BEGIN_SEQ = /\x1b\[\?(?:\d*;)*2026(?:;\d*)*h/;
/** The start of a DEC private mode set or reset, still open at the end of a chunk. */
const MODE_SET_PREFIX = /^\x1b(?:\[(?:\?[\d;]*)?)?$/;
/** Longest tail kept as carry: a mode list longer than this is not an app's begin. */
const MAX_CARRY = 32;

/**
 * Whether `data`, following the `carry` the previous chunk left, holds a begin of a
 * synchronized update, and the unfinished sequence at its end to pass back as `carry` with
 * the next chunk. Most chunks hold no `2026` and only their tail is looked at.
 */
export function scanSyncBegin(data: string, carry = ''): { begun: boolean; carry: string } {
  const text = carry === '' ? data : carry + data;
  const begun = text.includes('2026') && SYNC_BEGIN_SEQ.test(text);
  const esc = text.lastIndexOf('\x1b');
  const tail = esc >= 0 && text.length - esc <= MAX_CARRY ? text.slice(esc) : '';
  return { begun, carry: MODE_SET_PREFIX.test(tail) ? tail : '' };
}
