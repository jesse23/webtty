// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Copying selected text (strategy): a fallback chain of ClipboardItem, writeText and
// execCommand, each tried when the one before is missing or fails (ADR 061).

/** The browser APIs the copy chain uses, injected so each strategy is tested on its own. */
export interface ClipboardEnv {
  clipboard?: Partial<Pick<Clipboard, 'write' | 'writeText'>>;
  ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
  document: Pick<Document, 'activeElement' | 'execCommand'>;
  /** The hidden textarea execCommand copies from. */
  textarea: HTMLTextAreaElement;
  warn(...args: unknown[]): void;
}

/** The page's clipboard, read when a copy is made (Bun and older browsers have no ClipboardItem). */
export function browserClipboardEnv(
  textarea: HTMLTextAreaElement,
  doc: ClipboardEnv['document'],
): ClipboardEnv {
  return {
    clipboard: navigator.clipboard,
    ClipboardItem: typeof ClipboardItem !== 'undefined' ? ClipboardItem : undefined,
    document: doc,
    textarea,
    warn: (...args) => console.warn(...args),
  };
}

/**
 * Copies `text`, modern APIs first:
 * 1. ClipboardItem, which Safari accepts because the item is created synchronously within
 *    the user gesture even though the write is async; on failure, writeText.
 * 2. navigator.clipboard.writeText (Chrome; may fail in Safari); on failure, execCommand.
 * 3. execCommand('copy') from the hidden textarea, for older browsers.
 */
export function copyText(text: string, env: ClipboardEnv): void {
  const { clipboard } = env;
  if (clipboard && env.ClipboardItem) {
    try {
      const blob = new Blob([text], { type: 'text/plain' });
      const item = new env.ClipboardItem({ 'text/plain': blob });
      // A missing write() throws here, and the chain falls through
      clipboard.write!([item]).catch((err) => {
        env.warn('ClipboardItem write failed, trying writeText:', err);
        copyWithWriteText(text, env);
      });
      return;
    } catch {
      // ClipboardItem not supported or failed: fall through
    }
  }
  if (clipboard?.writeText) {
    writeTextOrExecCommand(text, env);
    return;
  }
  copyWithExecCommand(text, env);
}

/** writeText when the clipboard has it, else execCommand. */
export function copyWithWriteText(text: string, env: ClipboardEnv): void {
  if (env.clipboard?.writeText) writeTextOrExecCommand(text, env);
  else copyWithExecCommand(text, env);
}

/** writeText, falling back to execCommand when the write is refused. */
function writeTextOrExecCommand(text: string, env: ClipboardEnv): void {
  env.clipboard!.writeText!(text).catch((err) => {
    env.warn('Clipboard writeText failed, trying execCommand:', err);
    copyWithExecCommand(text, env);
  });
}

/**
 * Copies with the legacy execCommand: the text goes into the hidden textarea, placed
 * offscreen so it can be selected, and focus goes back where it was.
 */
export function copyWithExecCommand(text: string, env: ClipboardEnv): void {
  const previouslyFocused = env.document.activeElement as HTMLElement | null;
  try {
    const { textarea } = env;
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';

    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    const success = env.document.execCommand('copy');
    if (previouslyFocused) previouslyFocused.focus();
    if (!success) env.warn('execCommand copy failed');
  } catch (err) {
    env.warn('execCommand copy threw:', err);
    if (previouslyFocused) previouslyFocused.focus();
  }
}
