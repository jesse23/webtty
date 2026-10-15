// The vendored Terminal's options from the client config (util, pure; ADR 011, ADR 046,
// ADR 051, ADR 052, ADR 056). The engine and the translated theme come in as arguments.

import type { Ghostty, ITerminalOptions } from '../vendor/ghostty-web';
import type { ClientConfig } from './client-config';

/** The options `new Terminal()` gets, one place mapping webtty's config names to its own. */
export function toTerminalOptions(
  config: ClientConfig,
  terminalTheme: Record<string, string>,
  ghostty: Ghostty,
): ITerminalOptions {
  return {
    ghostty,
    cols: config.cols,
    rows: config.rows,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorStyleBlink,
    fontSize: config.fontSize,
    fontFamily: config.fontFamily,
    scrollbackLines: config.scrollbackLines,
    mouseScrollSpeed: config.mouseScrollSpeed,
    // The terminal copies a mouse selection on mouseup, once, only when this is on (ADR 011).
    // A drag the app takes, while it tracks the mouse and Shift is up, selects nothing.
    copyOnSelect: config.copyOnSelect,
    // What a right-click the app does not take does; the terminal handles every
    // contextmenu, and asks for a paste through onPasteRequest (ADR 051)
    rightClickBehavior: config.rightClickBehavior,
    // Programs may write the clipboard with OSC 52; off, Ghostty ignores it (ADR 052)
    clipboardWrite: config.clipboardWrite,
    // Programs may ask for desktop notifications with OSC 9 / OSC 777 (ADR 056)
    desktopNotifications: config.desktopNotifications,
    theme: terminalTheme,
  };
}
