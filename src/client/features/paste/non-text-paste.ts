// Whether a paste is non-text, and the Ctrl+V it becomes (util, pure, ADR 037, ADR 049).

/**
 * Ctrl+V for an empty text/plain payload, a non-text paste (e.g. an image) whose receiving
 * TUI may read the native clipboard on Ctrl+V; null for text. Never substitute Ctrl+V for
 * nonempty text: in remote apps it can mean something else entirely. Text is encoded by
 * the terminal (term.paste, ADR 049).
 */
export function nonTextPaste(text: string): string | null {
  return text ? null : '\x16';
}
