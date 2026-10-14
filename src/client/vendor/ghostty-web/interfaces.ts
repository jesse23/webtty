/**
 * xterm.js-compatible interfaces
 */

import type { Ghostty } from './ghostty';

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

  // The Ghostty WASM instance, from Ghostty.load() (webtty: upstream's init() and its
  // module-level instance are removed)
  ghostty: Ghostty;
}

export interface ITheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;

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

export interface IDisposable {
  dispose(): void;
}

export type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

export interface ITerminalAddon {
  activate(terminal: ITerminalCore): void;
  dispose(): void;
}

export interface ITerminalCore {
  element?: HTMLElement;
}

// ============================================================================
// Buffer API Interfaces (xterm.js compatibility)
// ============================================================================

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
