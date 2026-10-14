// What each of Ghostty's shortcuts does (command map, ADR 054, ADR 055, ADR 057, ADR 060):
// one handler per action, each settling its key in the order Ghostty's shortcuts always
// have, so the key dispatcher is a table lookup and each command is tested alone.

import type { Shortcut } from './shortcut-map';

/** A shortcut action, the command map's key. */
export type ShortcutAction = Shortcut['action'];

/**
 * What a command does with its key: `consume` prevents its default and stops every later
 * listener; `stop` only stops the later listeners, so the browser's own default still
 * runs. A command that calls neither leaves the key to the terminal and the app.
 */
export interface KeyControl {
  consume(): void;
  stop(): void;
}

/** The find bar as the shortcuts drive it; features/keyboard never imports features/find. */
export interface FindBarHost {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  go(direction: 'next' | 'previous'): void;
}

/** What the commands act on, passed in by the key dispatcher. */
export interface ShortcutHost {
  find: FindBarHost;
  /** Scrolls to the previous (-1) or next (1) prompt (ADR 057). */
  jumpToPrompt(delta: -1 | 1): void;
  /** Copies the selection; false when there is none. */
  copySelection(): boolean;
  /** Clears the screen; false on the alternate screen (ADR 054). */
  clearScreen(): boolean;
  /** Reads the clipboard and pastes it; false when the browser cannot read it (ADR 014). */
  pasteFromClipboard(): boolean;
}

/** A shortcut's command: runs it and settles its key through `key`. */
export type ShortcutCommand = (shortcut: Shortcut, key: KeyControl) => void;

/** The commands, one per action, acting on `host`. */
export function createShortcutCommands(
  host: ShortcutHost,
): Record<ShortcutAction, ShortcutCommand> {
  // Escape, closing and moving are the app's while the bar is closed (ADR 055)
  const whileFinding =
    (run: () => void): ShortcutCommand =>
    (_shortcut, key) => {
      if (!host.find.isOpen) return;
      key.consume();
      run();
    };
  // Not done and performable: the input handler sends the key to the app, as Ghostty does
  const performable =
    (run: () => boolean): ShortcutCommand =>
    (shortcut, key) => {
      if (!run() && shortcut.performable) return;
      key.consume();
    };
  // Ghostty's jump_to_prompt is consumed with or without a prompt to go to (ADR 057)
  const jump =
    (delta: -1 | 1): ShortcutCommand =>
    (_shortcut, key) => {
      host.jumpToPrompt(delta);
      key.consume();
    };
  return {
    find: (_shortcut, key) => {
      key.consume();
      host.find.open();
    },
    findClose: whileFinding(() => host.find.close()),
    findNext: whileFinding(() => host.find.go('next')),
    findPrevious: whileFinding(() => host.find.go('previous')),
    promptPrevious: jump(-1),
    promptNext: jump(1),
    // Without the clipboard API the browser's own paste may still fire 'paste'
    paste: (_shortcut, key) => {
      if (host.pasteFromClipboard()) key.consume();
      else key.stop();
    },
    copy: performable(() => host.copySelection()),
    clear: performable(() => host.clearScreen()),
  };
}
