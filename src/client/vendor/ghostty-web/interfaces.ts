// Derived from coder/ghostty-web lib/interfaces.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The xterm.js-compatible public types (types): the terminal's options and theme, the
// addon and disposable contracts, the event signature the emitters implement, and the
// read-only buffer API the link providers and webtty's kitty graphics read.

import type { Ghostty } from './ghostty';
import type { RightClickBehavior } from './mouse-route';

/** What `new Terminal(options)` takes; unset values get `TERMINAL_DEFAULTS`. */
export interface ITerminalOptions {
  cols?: number; // Default: 80
  rows?: number; // Default: 24
  cursorBlink?: boolean; // Default: false
  cursorStyle?: 'block' | 'underline' | 'bar';
  theme?: ITheme;
  scrollbackLines?: number; // History in lines, 0 = no line limit; default 10000 (webtty, ADR 046)
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  allowTransparency?: boolean;

  // Phase 1 additions
  convertEol?: boolean; // Convert \n to \r\n (default: false)
  disableStdin?: boolean; // Disable keyboard input (default: false)

  // Scrolling options
  mouseScrollSpeed?: number; // Wheel ticks per line/page wheel event when the app tracks the mouse (default: 1)

  // Selection options
  copyOnSelect?: boolean; // Copy a mouse selection to the clipboard when it is made (default: true) (webtty)
  rightClickBehavior?: RightClickBehavior; // What a right-click the app does not take does (default: 'contextMenu') (webtty, ADR 051)

  // Clipboard options
  clipboardWrite?: boolean; // Report program clipboard writes (OSC 52) through onClipboardWrite; read when the terminal is created (default: true) (webtty, ADR 052)

  // Notification options
  desktopNotifications?: boolean; // Report desktop notifications (OSC 9, OSC 777) through onDesktopNotification; read when the terminal is created (default: true) (webtty, ADR 056)

  // The Ghostty WASM instance, from Ghostty.load() (webtty: upstream's init() and its
  // module-level instance are removed)
  ghostty: Ghostty;
}

/** The terminal's colours as CSS colour strings; unset ones keep the default theme's. */
export interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  // Search matches and the selected match, Ghostty's `search-*` colours (webtty, ADR 055)
  searchBackground?: string;
  searchForeground?: string;
  searchSelectedBackground?: string;
  searchSelectedForeground?: string;

  // ANSI colors (0-15)
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

/** Anything that releases what it holds; returned by every event subscription. */
export interface IDisposable {
  dispose(): void;
}

/** An xterm-style `onX` event: subscribe a listener, dispose the result to unsubscribe. */
export type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

/** An addon `loadAddon` activates on the terminal and disposes with it. */
export interface ITerminalAddon {
  activate(terminal: ITerminalCore): void;
  dispose(): void;
}

/** What an addon sees of the terminal it is activated on. */
export interface ITerminalCore {
  element?: HTMLElement;
  /** The cell size, for FitAddon; set while the terminal is open (webtty, ADR 061) */
  readonly renderer?: { getMetrics(): { width: number; height: number } };
}

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
export interface IBufferNamespace {
  /** The currently active buffer (normal or alternate) */
  readonly active: IBuffer;
  /** The normal buffer (primary screen) */
  readonly normal: IBuffer;
  /** The alternate buffer (used by full-screen apps like vim) */
  readonly alternate: IBuffer;
}

/**
 * A terminal buffer (normal or alternate screen)
 */
export interface IBuffer {
  /** Buffer type: 'normal' or 'alternate' */
  readonly type: 'normal' | 'alternate';
  /** Cursor X position (0-indexed) */
  readonly cursorX: number;
  /** Cursor Y position (0-indexed, relative to viewport) */
  readonly cursorY: number;
  /** Total buffer length (rows + scrollback for normal, just rows for alternate) */
  readonly length: number;

  /**
   * Get a line from the buffer
   * @param y Line index (0 = top of scrollback for normal buffer)
   * @returns Line object or undefined if out of bounds
   */
  getLine(y: number): IBufferLine | undefined;
}

/**
 * A single line in the buffer
 */
export interface IBufferLine {
  /** Length of the line (in columns) */
  readonly length: number;

  /**
   * Get a cell from this line
   * @param x Column index (0-indexed)
   * @returns Cell object or undefined if out of bounds
   */
  getCell(x: number): IBufferCell | undefined;
}

/**
 * A single cell in the buffer
 */
export interface IBufferCell {
  /** Get hyperlink ID for this cell (0 = no link) */
  getHyperlinkId(): number;
  /** Get the Unicode codepoint for this cell */
  getCodepoint(): number;
}
