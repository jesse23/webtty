// An empty text/plain payload is a non-text paste (e.g. an image), whose
// receiving TUI may read the native clipboard on Ctrl+V: the paste is Ctrl+V.
// Never substitute Ctrl+V for nonempty text: in remote apps it can mean
// something else entirely. Text is encoded by the terminal (term.paste, ADR 049).
export function nonTextPaste(text: string): string | null {
  return text ? null : '\x16';
}
