/**
 * Who a mouse press and a right-click belong to: the app, while it tracks the mouse, or
 * webtty (selection, menu, copy, paste). Shift is the bypass, as in Ghostty, kitty,
 * WezTerm, xterm, Windows Terminal and VS Code. (webtty, ADR 051)
 */

/** What a right-click does when the app does not take it (the config's `rightClickBehavior`). */
export type RightClickBehavior = 'contextMenu' | 'copyPaste' | 'paste' | 'none';

/**
 * What a `contextmenu` event does:
 * - `app`: nothing more; the app got the press and release, and the browser menu is cancelled
 * - `menu`: the browser menu
 * - `copy`: copy the selection and clear it, no menu
 * - `paste`: paste the clipboard, no menu
 * - `none`: nothing, no menu
 */
export type RightClickAction = 'app' | 'menu' | 'copy' | 'paste' | 'none';

/** A press goes to the app while it tracks the mouse, unless Shift is held. */
export function pressToApp(tracking: boolean, shiftKey: boolean): boolean {
  return tracking && !shiftKey;
}

export interface RightClick {
  /** The app tracks the mouse (any DEC mouse tracking mode is on). */
  tracking: boolean;
  shiftKey: boolean;
  /** The menu was opened from the keyboard (Menu key, Shift+F10), not by a button. */
  fromKeyboard: boolean;
  behavior: RightClickBehavior;
  /** There is a selection with text to copy. */
  hasSelection: boolean;
}

/**
 * The one decision for a `contextmenu` event. A right button the app takes is the app's;
 * Shift+right-click, a keyboard menu, or any right-click while the app does not track
 * the mouse follow `behavior`. A webtty-drawn menu would be one more behaviour here.
 */
export function rightClickAction(click: RightClick): RightClickAction {
  if (!click.fromKeyboard && pressToApp(click.tracking, click.shiftKey)) return 'app';
  switch (click.behavior) {
    case 'copyPaste':
      return click.hasSelection ? 'copy' : 'menu';
    case 'paste':
      return 'paste';
    case 'none':
      return 'none';
    default:
      return 'menu';
  }
}

/**
 * Tells a `contextmenu` opened by a button from one opened from the keyboard. A right
 * press, or a Ctrl+left press (macOS opens the menu on it), arms it; a key press or any
 * other press disarms it, and a `contextmenu` uses it up. The menu opens on press on
 * macOS and Linux and on release on Windows, after the press either way.
 */
export class MenuSource {
  private armed = false;

  press(e: Pick<MouseEvent, 'button' | 'ctrlKey'>): void {
    this.armed = e.button === 2 || (e.button === 0 && e.ctrlKey);
  }

  key(): void {
    this.armed = false;
  }

  /** Whether this `contextmenu` came from the keyboard; call once per event. */
  fromKeyboard(e: Pick<MouseEvent, 'button'>): boolean {
    const fromButton = this.armed || e.button === 2;
    this.armed = false;
    return !fromButton;
  }
}
