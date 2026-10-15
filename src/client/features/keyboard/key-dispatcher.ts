// The one container capture `keydown` listener for webtty's own keys (feature, ADR 018,
// ADR 054, ADR 055, ADR 057, ADR 060). A configured binding wins; otherwise Ghostty's
// shortcuts run through the command map. As a capture listener on the container it runs
// after the terminal's own capture listener (the context-menu key) and before the input
// handler's bubble listener, so a key it consumes never reaches the app.

import type { KeyboardBinding } from '../../app/client-config';
import type { ClientContext, Feature } from '../../app/client-context';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import { findBinding } from './key-bindings';
import { createShortcutCommands, type FindBarHost, type KeyControl } from './shortcut-commands';
import { shortcutFor } from './shortcut-map';

/** The PTY socket as the dispatcher writes to it. */
export interface KeySink {
  isOpen(): boolean;
  send(data: string): void;
}

/** What the dispatcher needs besides the context: the handles the root built before it. */
export interface KeyDispatcherDeps {
  connection: KeySink;
  find: FindBarHost;
  /** Cmd+K: the root's clear, which also clears the graphics and the smooth scroll (ADR 054). */
  clearScreen(): boolean;
  /** The paste service's clipboard read; false when the browser cannot read it (ADR 014). */
  pasteFromClipboard(): boolean;
}

/** The installed dispatcher; nothing to call, only to dispose. */
export type KeyDispatcherFeature = Feature;

/** The terminal as the dispatcher's keys act on it. */
export interface KeyTerminal {
  scrollToBottom(): void;
  jumpToPrompt(delta: number): void;
  copySelection(): boolean;
}

/** What the keydown handler reads: the terminal, the configured bindings and the platform. */
export interface KeyHandlerHost {
  term: KeyTerminal;
  bindings: readonly KeyboardBinding[];
  /** Whether Ghostty's macOS shortcuts apply (ADR 054). */
  mac: boolean;
}

/** The key fields and event calls the dispatcher uses. */
export type DispatchedKey = Pick<
  KeyboardEvent,
  | 'key'
  | 'code'
  | 'shiftKey'
  | 'ctrlKey'
  | 'altKey'
  | 'metaKey'
  | 'preventDefault'
  | 'stopPropagation'
  | 'stopImmediatePropagation'
>;

/** The dispatcher's keydown handler, separate from its listener so it is tested on plain events. */
export function createKeyHandler(
  host: KeyHandlerHost,
  deps: KeyDispatcherDeps,
): (e: DispatchedKey) => void {
  const { term, bindings, mac } = host;
  const commands = createShortcutCommands({
    find: deps.find,
    jumpToPrompt: (delta) => term.jumpToPrompt(delta),
    copySelection: () => term.copySelection(),
    clearScreen: deps.clearScreen,
    pasteFromClipboard: deps.pasteFromClipboard,
  });
  return (e) => {
    // Configured key+mods combos win over the terminal and the shortcuts, and send their
    // chars straight to the PTY (ADR 018). A binding without chars only consumes the key.
    const binding = findBinding(e, bindings);
    if (binding) {
      e.preventDefault();
      e.stopPropagation();
      if (binding.chars && deps.connection.isOpen()) {
        // A keystroke scrolls to the bottom, as the terminal's own keys do (ADR 055)
        term.scrollToBottom();
        deps.connection.send(binding.chars);
      }
      return;
    }
    const shortcut = shortcutFor(e, mac);
    if (shortcut) commands[shortcut.action](shortcut, keyControl(e));
  };
}

/** Adds the container capture `keydown` listener. */
export function installKeyDispatcher(
  ctx: ClientContext,
  deps: KeyDispatcherDeps,
): KeyDispatcherFeature {
  const store = new DisposableStore();
  const { term, config, mac } = ctx;
  const handle = createKeyHandler({ term, bindings: config.keyboardBindings, mac }, deps);
  store.add(listen(ctx.container, 'keydown', handle, { capture: true }));
  return { dispose: () => store.dispose() };
}

/** The key's calls as the commands make them; `stopPropagation` is the bindings' alone. */
function keyControl(e: DispatchedKey): KeyControl {
  return {
    consume: () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    stop: () => e.stopImmediatePropagation(),
  };
}
