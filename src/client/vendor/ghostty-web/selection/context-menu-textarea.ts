// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The browser menu's target (object): the hidden textarea is moved under the pointer,
// holding the selection, so a right-click menu offers Copy and Paste, and is hidden again
// once the menu closes (ADR 051, ADR 061). dispose() cancels the wait and the listeners
// for the menu to close (ADR 065).

import { type Disposable, toDisposable } from '../lifecycle/disposable-store';

/** How long after showing the menu, in ms, the textarea starts listening for the menu to close. */
export const CONTEXT_MENU_RESET_DELAY_MS = 10;

/** The document events that close the menu. */
export type MenuCloseSource = Pick<Document, 'addEventListener' | 'removeEventListener'>;

/** The timeout the menu's reset waits on, injected so tests run it by hand. */
export interface MenuTimers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** The global timeouts, read when called. */
export const browserMenuTimers: MenuTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Moves the hidden textarea under a right-click and back. */
export class ContextMenuTextarea implements Disposable {
  // Each menu's wait, then its close listeners, until they are done
  private readonly pending = new Set<Disposable>();

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly doc: MenuCloseSource,
    private readonly timers: MenuTimers = browserMenuTimers,
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
    // click, contextmenu or blur, which is the menu closing
    const id = this.timers.setTimeout(() => {
      this.pending.delete(wait);
      this.hideOnMenuClose();
    }, CONTEXT_MENU_RESET_DELAY_MS);
    const wait = toDisposable(() => this.timers.clearTimeout(id));
    this.pending.add(wait);
  }

  /** Cancels a menu's wait and removes its close listeners (ADR 065). Calling it again does nothing. */
  dispose(): void {
    for (const item of this.pending) item.dispose();
    this.pending.clear();
  }

  /** Listens once for the menu to close, then hides the textarea and drops the other listeners. */
  private hideOnMenuClose(): void {
    const { textarea, doc } = this;
    const listening = toDisposable(() => {
      this.pending.delete(listening);
      doc.removeEventListener('click', reset);
      doc.removeEventListener('contextmenu', reset);
      textarea.removeEventListener('blur', reset);
    });
    const reset = () => {
      textarea.style.pointerEvents = 'none';
      textarea.style.zIndex = '-10';
      textarea.style.width = '0';
      textarea.style.height = '0';
      textarea.style.left = '0';
      textarea.style.top = '0';
      textarea.value = '';
      listening.dispose();
    };
    doc.addEventListener('click', reset, { once: true });
    doc.addEventListener('contextmenu', reset, { once: true });
    textarea.addEventListener('blur', reset, { once: true });
    this.pending.add(listening);
  }
}
