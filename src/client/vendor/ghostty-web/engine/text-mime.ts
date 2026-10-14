// webtty (ADR 052, ADR 061), not from upstream.
// The clipboard text check (util): which MIME names of a program's clipboard write carry
// plain text, as Ghostty decides it.

/** The MIME names Ghostty treats as plain text. */
const TEXT_MIMES = new Set([
  'text/plain',
  'text/plain;charset=utf-8',
  'UTF8_STRING',
  'TEXT',
  'STRING',
]);

/**
 * Whether a clipboard MIME type names plain text: Ghostty's `isTextMime` list
 * (`src/terminal/clipboard.zig`), the names text goes by on every platform. (webtty,
 * ADR 052)
 */
export function isTextMime(mime: string): boolean {
  return TEXT_MIMES.has(mime);
}
