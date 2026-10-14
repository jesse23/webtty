// Find in the scrollback with libghostty-vt's search (feature, ADR 055, ADR 060): the find
// bar, appended to the body outside the terminal's container so its keys are its own, and
// fed the terminal's match count. Closing it ends the search and refocuses the terminal.

import type { ClientContext, Feature } from '../../app/client-context';
import { DisposableStore } from '../../vendor/ghostty-web';
import { FindBar } from './find-bar';
import type { ShortcutActionOf } from './find-keys';

/** What the find feature needs besides the context. */
export interface FindDeps {
  /** The keyboard feature's shortcut lookup, so the field knows the find keys (ADR 055). */
  shortcutActionOf: ShortcutActionOf;
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/** The find bar as the key dispatcher drives it. */
export interface FindFeature extends Feature {
  /** Whether the bar is showing; the next, previous and close keys are the app's otherwise. */
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  go(direction: 'next' | 'previous'): void;
}

/** Builds the find bar in the body and subscribes it to `onFindChange`. */
export function installFind(ctx: ClientContext, deps: FindDeps): FindFeature {
  const { term, doc, terminalTheme } = ctx;
  const store = new DisposableStore();
  const bar = store.add(
    new FindBar(
      doc.body,
      terminalTheme,
      deps.shortcutActionOf,
      {
        find: (needle) => term.find(needle),
        next: () => term.findNext(),
        previous: () => term.findPrevious(),
        close: () => {
          term.endFind();
          term.focus();
        },
      },
      {
        document: doc,
        setTimeout: (run, ms) => deps.setTimeout(run, ms),
        // The handle is the one deps.setTimeout returned.
        clearTimeout: (handle) => deps.clearTimeout(handle as number),
      },
    ),
  );
  store.add(term.onFindChange((state) => bar.update(state)));
  return {
    get isOpen() {
      return bar.isOpen;
    },
    open: () => bar.open(),
    close: () => bar.close(),
    go: (direction) => bar.go(direction),
    dispose: () => store.dispose(),
  };
}
