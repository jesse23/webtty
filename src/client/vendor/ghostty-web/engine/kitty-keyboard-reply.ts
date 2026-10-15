// webtty (ADR 042, ADR 061), not from upstream.
// The kitty keyboard reply check (util): the one `WRITE_PTY` reply the binding drops,
// because webtty's input handler never encodes keys with the kitty flags.

/**
 * Whether one `WRITE_PTY` reply is the kitty keyboard query reply `ESC [ ? <flags> u`
 * (`queryKittyKeyboard` in Ghostty's `stream_terminal.zig`). No other reply has
 * this shape: DECRQM ends in `$y`, DA in `c`.
 */
export function isKittyKeyboardReply(reply: Uint8Array): boolean {
  const n = reply.length;
  if (n < 5 || reply[0] !== 0x1b || reply[1] !== 0x5b || reply[2] !== 0x3f) return false;
  if (reply[n - 1] !== 0x75) return false;
  for (let i = 3; i < n - 1; i++) {
    if (reply[i] < 0x30 || reply[i] > 0x39) return false;
  }
  return true;
}
