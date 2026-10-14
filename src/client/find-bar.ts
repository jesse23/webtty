/**
 * The find bar (ADR 055): Ghostty's search overlay as a small DOM element at the top
 * right of the terminal. The canvas is invisible to the browser's own find, so this
 * finds with libghostty-vt's search through the terminal.
 *
 * It sits outside the terminal's container, so keys typed in it never reach the
 * terminal's key handling and focus in it is not the terminal's. Typing searches after
 * a short pause, as GTK's search entry does; Enter and Shift+Enter go to the next and
 * previous match, Escape closes. The count is Ghostty's `selected/total`: `0/n` until a
 * match is selected.
 */
import { shortcutFor } from './shortcuts';

/** The match count and the selected match's index (0 the newest), as the terminal reports them. */
export interface FindState {
  total: number;
  selected: number | null;
}

export interface FindBarActions {
  find(needle: string): void;
  next(): void;
  previous(): void;
  /** The bar closed: end the search and give the terminal its focus back. */
  close(): void;
}

/** GtkSearchEntry's default search delay. */
export const FIND_DELAY_MS = 150;

/** The count as Ghostty's search overlay shows it. */
export function countLabel(state: FindState): string {
  if (state.total === 0) return '0/0';
  return `${state.selected === null ? 0 : state.selected + 1}/${state.total}`;
}

/** The count for a screen reader. */
export function countDescription(state: FindState): string {
  if (state.total === 0) return 'No matches';
  const matches = state.total === 1 ? '1 match' : `${state.total} matches`;
  if (state.selected === null) return matches;
  return `Match ${state.selected + 1} of ${state.total}`;
}

/** What a key in the find field does: the field's own keys, then the find shortcuts. */
export function fieldKey(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  mac: boolean,
): 'next' | 'previous' | 'close' | 'select' | null {
  if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    return e.shiftKey ? 'previous' : 'next';
  }
  switch (shortcutFor(e, mac)?.action) {
    case 'findClose':
      return 'close';
    case 'findNext':
      return 'next';
    case 'findPrevious':
      return 'previous';
    case 'find':
      return 'select';
  }
  return null;
}

export class FindBar {
  private readonly root: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly status: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The text the terminal searches for: the field's, once the delay has passed. */
  private searched = '';
  private shown = false;

  constructor(
    parent: HTMLElement,
    theme: Record<string, string | undefined>,
    private readonly mac: boolean,
    private readonly actions: FindBarActions,
  ) {
    const root = document.createElement('div');
    root.className = 'find-bar';
    root.setAttribute('role', 'search');
    root.hidden = true;
    const style = root.style;
    if (theme.background) style.setProperty('--find-bg', theme.background);
    if (theme.foreground) style.setProperty('--find-fg', theme.foreground);
    const border = theme.brightBlack ?? theme.foreground;
    if (border) style.setProperty('--find-border', border);

    const label = document.createElement('label');
    label.className = 'find-bar-hidden';
    label.htmlFor = 'find-bar-input';
    label.textContent = 'Find in terminal';

    const input = document.createElement('input');
    input.id = 'find-bar-input';
    input.type = 'text';
    input.placeholder = 'Find…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', () => this.schedule());
    input.addEventListener('keydown', (e) => this.onKey(e));

    const count = document.createElement('span');
    count.className = 'find-bar-count';
    count.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'find-bar-hidden';
    status.setAttribute('role', 'status');

    // ↑ is next (older output), as in Ghostty
    const button = (text: string, title: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', run);
      return b;
    };
    root.append(
      label,
      input,
      count,
      status,
      button('↑', 'Next match (older)', () => this.go('next')),
      button('↓', 'Previous match (newer)', () => this.go('previous')),
      button('×', 'Close', () => this.close()),
    );
    parent.appendChild(root);
    this.root = root;
    this.input = input;
    this.count = count;
    this.status = status;
    this.update({ total: 0, selected: null });
  }

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

  update(state: FindState): void {
    this.count.textContent = countLabel(state);
    const description = countDescription(state);
    if (this.status.textContent !== description) this.status.textContent = description;
  }

  private onKey(e: KeyboardEvent): void {
    // Composing (IME): Enter commits the text, not a search step
    if (e.isComposing) return;
    const action = fieldKey(e, this.mac);
    if (!action) return;
    e.preventDefault();
    if (action === 'close') this.close();
    else if (action === 'select') this.input.select();
    else this.go(action);
  }

  private schedule(): void {
    this.cancel();
    this.timer = setTimeout(() => this.flush(), FIND_DELAY_MS);
  }

  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
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
