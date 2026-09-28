// An empty text/plain payload is a non-text paste (e.g. an image), whose
// receiving TUI may read the native clipboard on Ctrl+V. Never substitute
// Ctrl+V for nonempty text: in remote apps it can mean something else entirely.
export function encodePaste(text: string, bracketedPaste: boolean): string {
  if (!text) return '\x16';
  if (bracketedPaste && /[\r\n]/.test(text)) return `\x1b[200~${text}\x1b[201~`;
  // Without mode 2004, raw text is the only interoperable fallback. Its
  // newlines may be interpreted as Enter by the receiving app.
  return text;
}
