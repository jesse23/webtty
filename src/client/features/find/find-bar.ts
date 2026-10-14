/**
 * The find bar (view, ADR 055): Ghostty's search overlay as a small DOM element at the top
 * right of the terminal. The canvas is invisible to the browser's own find, so this
 * finds with libghostty-vt's search through the terminal.
 *
 * It sits outside the terminal's container, so keys typed in it never reach the
 * terminal's key handling and focus in it is not the terminal's. Typing searches after
 * a short pause, as GTK's search entry does; Enter and Shift+Enter go to the next and
 * previous match, Escape closes. The count is Ghostty's `selected/total`: `0/n` until a
 * match is selected.
 */
import { DisposableStore, listen, toDisposable } from '../../vendor/ghostty-web';
import { countDescription, countLabel, type FindState } from './find-format';
import { fieldKey, type ShortcutActionOf } from './find-keys';

/** What the bar asks the terminal to do. */
export interface FindBarActions {
  find(needle: string): void;
  next(): void;
  previous(): void;
  /** The bar closed: end the search and give the terminal its focus back. */
  close(): void;
}

/** The browser objects the bar builds its DOM in and times its search delay with. */
export interface FindBarDeps {
  document: Document;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The colours the bar takes from the terminal theme. */
export type FindBarTheme = Record<string, string | undefined>;

/** GtkSearchEntry's default search delay. */
export const FIND_DELAY_MS = 150;

/** The find bar: built in the constructor, appended to `parent`, removed by `dispose()`. */
export class FindBar {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly status: HTMLElement;
  private readonly store = new DisposableStore();
  private timer: unknown = null;
  /** The text the terminal searches for: the field's, once the delay has passed. */
  private searched = '';
  private shown = false;

  constructor(
    parent: HTMLElement,
    theme: FindBarTheme,
    private readonly shortcutActionOf: ShortcutActionOf,
    private readonly actions: FindBarActions,
    private readonly deps: FindBarDeps = {
      document: parent.ownerDocument,
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
  ) {
    const doc = deps.document;
    this.root = doc.createElement('div');
    this.root.className = 'find-bar';
    this.root.setAttribute('role', 'search');
    this.root.hidden = true;
    applyTheme(this.root.style, theme);

    const label = doc.createElement('label');
    label.className = 'find-bar-hidden';
    label.htmlFor = 'find-bar-input';
    label.textContent = 'Find in terminal';

    this.input = this.createInput();
    this.count = doc.createElement('span');
    this.count.className = 'find-bar-count';
    this.count.setAttribute('aria-hidden', 'true');
    this.status = doc.createElement('span');
    this.status.className = 'find-bar-hidden';
    this.status.setAttribute('role', 'status');

    // ↑ is next (older output), as in Ghostty
    this.root.append(
      label,
      this.input,
      this.count,
      this.status,
      this.button('↑', 'Next match (older)', () => this.go('next')),
      this.button('↓', 'Previous match (newer)', () => this.go('previous')),
      this.button('×', 'Close', () => this.close()),
    );
    parent.appendChild(this.root);
    this.store.add(toDisposable(() => this.root.remove()));
    this.update({ total: 0, selected: null });
  }

  /** Whether the bar is showing, so the shortcuts know whether next/previous apply. */
  get isOpen(): boolean {
    return this.shown;
  }

  /**
   * Shows the bar with the field focused and its text selected. Reopened, it searches
   * the text it kept again.
   */
  open(): void {
    if (!this.shown) {
      this.shown = true;
      this.root.hidden = false;
      this.searched = '';
      this.flush();
    }
    this.input.focus();
    this.input.select();
  }

  /** Hides the bar and ends the search; the field keeps its text. */
  close(): void {
    if (!this.shown) return;
    this.cancel();
    this.shown = false;
    this.root.hidden = true;
    this.actions.close();
  }

  /** Goes to the next or previous match, searching the field's text first if pending. */
  go(direction: 'next' | 'previous'): void {
    if (!this.shown) return;
    this.flush();
    if (direction === 'next') this.actions.next();
    else this.actions.previous();
  }

  /** Shows the terminal's latest count; the live region is written only when it changes. */
  update(state: FindState): void {
    this.count.textContent = countLabel(state);
    const description = countDescription(state);
    if (this.status.textContent !== description) this.status.textContent = description;
  }

  /** Removes the bar and its listeners and drops a pending search. Idempotent. */
  dispose(): void {
    this.cancel();
    this.store.dispose();
  }

  private createInput(): HTMLInputElement {
    const input = this.deps.document.createElement('input');
    input.id = 'find-bar-input';
    input.type = 'text';
    input.placeholder = 'Find…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    this.store.add(listen(input, 'input', () => this.schedule()));
    this.store.add(listen(input, 'keydown', (e) => this.onKey(e)));
    return input;
  }

  private button(text: string, title: string, run: () => void): HTMLButtonElement {
    const b = this.deps.document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    this.store.add(listen(b, 'click', run));
    return b;
  }

  private onKey(e: KeyboardEvent): void {
    // Composing (IME): Enter commits the text, not a search step
    if (e.isComposing) return;
    const action = fieldKey(e, this.shortcutActionOf);
    if (!action) return;
    e.preventDefault();
    if (action === 'close') this.close();
    else if (action === 'select') this.input.select();
    else this.go(action);
  }

  private schedule(): void {
    this.cancel();
    this.timer = this.deps.setTimeout(() => this.flush(), FIND_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Searches the field's text now, if the terminal is not already searching it. */
  private flush(): void {
    this.cancel();
    const text = this.input.value;
    if (text === this.searched) return;
    this.searched = text;
    this.actions.find(text);
  }
}

/** Colours the bar from the theme through the CSS variables index.css reads. */
function applyTheme(style: CSSStyleDeclaration, theme: FindBarTheme): void {
  if (theme.background) style.setProperty('--find-bg', theme.background);
  if (theme.foreground) style.setProperty('--find-fg', theme.foreground);
  const border = theme.brightBlack ?? theme.foreground;
  if (border) style.setProperty('--find-border', border);
}
