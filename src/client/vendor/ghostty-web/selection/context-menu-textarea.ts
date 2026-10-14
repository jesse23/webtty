// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The browser menu's target (object): the hidden textarea is moved under the pointer,
// holding the selection, so a right-click menu offers Copy and Paste, and is hidden again
// once the menu closes (ADR 051, ADR 061).

/** How long after showing the menu, in ms, the textarea starts listening for the menu to close. */
export const CONTEXT_MENU_RESET_DELAY_MS = 10;

/** The document events that close the menu. */
export type MenuCloseSource = Pick<Document, 'addEventListener' | 'removeEventListener'>;

/** Moves the hidden textarea under a right-click and back. */
export class ContextMenuTextarea {
  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly doc: MenuCloseSource,
    private readonly setTimer: (run: () => void, ms: number) => unknown = (run, ms) =>
      setTimeout(run, ms),
  ) {}

  /**
   * Puts the textarea at the pointer, one pixel, invisible but taking pointer events, with
   * `selectedText` selected in it (empty when nothing is selected: the menu still offers
   * Paste), and focuses it so the browser's menu opens on it. The default is not prevented.
   */
  show(e: Pick<MouseEvent, 'clientX' | 'clientY'>, selectedText: string | null): void {
    const { textarea } = this;
    textarea.style.position = 'fixed';
    textarea.style.left = `${e.clientX}px`;
    textarea.style.top = `${e.clientY}px`;
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.zIndex = '1000';
    textarea.style.opacity = '0';
    // Pointer events on for now, so the context menu targets the textarea
    textarea.style.pointerEvents = 'auto';

    if (selectedText !== null) {
      textarea.value = selectedText;
      textarea.select();
      textarea.setSelectionRange(0, selectedText.length);
    } else {
      textarea.value = '';
    }
    textarea.focus();

    // After a short delay, so the menu appears first, hide the textarea again on the first
    // click, contextmenu or blur, which is the menu closing. The timer is not cancelled by
    // dispose (ADR 065).
    this.setTimer(() => this.hideOnMenuClose(), CONTEXT_MENU_RESET_DELAY_MS);
  }

  /** Listens once for the menu to close, then hides the textarea and drops the other listeners. */
  private hideOnMenuClose(): void {
    const { textarea, doc } = this;
    const reset = () => {
      textarea.style.pointerEvents = 'none';
      textarea.style.zIndex = '-10';
      textarea.style.width = '0';
      textarea.style.height = '0';
      textarea.style.left = '0';
      textarea.style.top = '0';
      textarea.value = '';

      doc.removeEventListener('click', reset);
      doc.removeEventListener('contextmenu', reset);
      textarea.removeEventListener('blur', reset);
    };
    doc.addEventListener('click', reset, { once: true });
    doc.addEventListener('contextmenu', reset, { once: true });
    textarea.addEventListener('blur', reset, { once: true });
  }
}
