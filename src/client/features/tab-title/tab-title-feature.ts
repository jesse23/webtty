// Wires the tab title to the terminal (feature, ADR 053, ADR 060): the program's OSC 0/2
// title and its bells go to the TabTitle, and focus in the terminal or a key clears the
// bell mark. Ghostty clears it on focus; a window focus reaches the container as a
// `focusin` too, while Chrome switching back to the tab only shows it.

import type { ClientContext, Feature } from '../../app/client-context';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import type { TabTitle } from './tab-title';

/** What the tab title feature needs besides the context. */
export interface TabTitleDeps {
  /** Created by the root before the wasm loads, so the tab is named at once. */
  tabTitle: TabTitle;
}

/** The installed tab title; nothing to call, only to dispose. */
export type TabTitleFeature = Feature;

/** Subscribes to `onTitleChange` and `onBell`; container `focusin` and window capture `keydown` attend. */
export function installTabTitle(ctx: ClientContext, deps: TabTitleDeps): TabTitleFeature {
  const { term, container, win } = ctx;
  const { tabTitle } = deps;
  const store = new DisposableStore();
  store.add(term.onTitleChange((title) => tabTitle.title(title)));
  store.add(term.onBell(() => tabTitle.bell()));
  store.add(listen(container, 'focusin', () => tabTitle.attended()));
  store.add(listen(win, 'keydown', () => tabTitle.attended(), { capture: true }));
  return { dispose: () => store.dispose() };
}
