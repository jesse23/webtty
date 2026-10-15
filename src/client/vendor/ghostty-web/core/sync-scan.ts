// webtty (ADR 067), not from upstream.
// The synchronized-update scanner (util): finds where the app begins a synchronized update
// (`CSI ? 2026 h`, alone or among other modes) in output, carrying an unfinished sequence
// across output chunks, as the cursor blink scanner does (engine/cursor-blink.ts), and
// where the last update in a chunk ends. Bytes are searched as bytes: only a chunk with
// `2026` in it is decoded whole.

/** A DEC private mode set whose modes include 2026. */
const SYNC_BEGIN_SEQ = /\x1b\[\?(?:\d*;)*2026(?:;\d*)*h/;
/** A DEC private mode reset whose modes include 2026, the end of an update. */
const SYNC_END_SEQ = /\x1b\[\?(?:\d*;)*2026(?:;\d*)*l/g;
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

const LATIN1 = new TextDecoder('latin1');

/** Whether `bytes` hold the digits `2026`. */
function has2026(bytes: Uint8Array): boolean {
  let i = bytes.indexOf(0x32);
  while (i >= 0 && i + 3 < bytes.length) {
    if (bytes[i + 1] === 0x30 && bytes[i + 2] === 0x32 && bytes[i + 3] === 0x36) return true;
    i = bytes.indexOf(0x32, i + 1);
  }
  return false;
}

/** A digit or `;`: a byte of a DEC mode list. */
function isModeListByte(byte: number): boolean {
  return (byte >= 0x30 && byte <= 0x39) || byte === 0x3b;
}

/**
 * `scanSyncBegin` over bytes, with the same result, decoding only what it must: a chunk
 * without `2026` can only finish a begin the carry started (its mode list and the `h`), and
 * leaves only the tail from its last ESC to carry.
 */
export function scanSyncBeginBytes(
  data: Uint8Array,
  carry = '',
): { begun: boolean; carry: string } {
  if (has2026(data)) return scanSyncBegin(LATIN1.decode(data), carry);
  let begun = false;
  if (carry !== '') {
    let end = 0;
    // The digits and semicolons that go on the carry's mode list, and the byte after them
    while (end < data.length && isModeListByte(data[end])) end++;
    begun = SYNC_BEGIN_SEQ.test(carry + LATIN1.decode(data.subarray(0, end + 1)));
  }
  const esc = data.lastIndexOf(0x1b);
  let tail = '';
  if (esc >= 0) {
    if (data.length - esc <= MAX_CARRY) tail = LATIN1.decode(data.subarray(esc));
  } else if (carry !== '' && carry.length + data.length <= MAX_CARRY) {
    tail = carry + LATIN1.decode(data);
  }
  return { begun, carry: MODE_SET_PREFIX.test(tail) ? tail : '' };
}

/**
 * Where the last synchronized update that ends in `data` ends: the index just past its
 * `CSI ? 2026 l`, in UTF-16 units for a string and bytes for bytes, or -1 if none ends in
 * it. An end split across chunks is not found; the update then paints on the next frame.
 */
export function lastSyncEnd(data: string | Uint8Array): number {
  if (typeof data !== 'string' && !has2026(data)) return -1;
  const text = typeof data === 'string' ? data : LATIN1.decode(data);
  if (typeof data === 'string' && !text.includes('2026')) return -1;
  let end = -1;
  for (const match of text.matchAll(SYNC_END_SEQ)) end = match.index + match[0].length;
  return end;
}
