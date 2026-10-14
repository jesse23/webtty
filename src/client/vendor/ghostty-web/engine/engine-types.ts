// Derived from coder/ghostty-web lib/types.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The engine's narrow interfaces (types): the terminal's creation config, the
// `GhosttyTerminal` and `KeyEncoder` contracts the rest of the vendored layer uses, and the
// values they take and return. Split parts import these instead of the binding's classes (ADR 061).

import type { DirtyState, GhosttyCell, RenderStateCursor } from './cell-types';
import type { FnTable } from '../fn-table';
import type { KeyEncoderOption, KeyEvent } from '../input/key-types';
import type { OfficialLayout } from './official-layout';
import type { OfficialWasmExports } from './wasm-exports';

/**
 * Terminal configuration, applied when the terminal is created. Colours are
 * 0xRRGGBB; undefined leaves one unset, so 0 is black. (webtty, ADR 047)
 */
export interface GhosttyTerminalConfig {
  /**
   * History in lines, with a 32 MiB ceiling; 0 = no line limit. Default 10,000.
   * (webtty, ADR 046)
   */
  scrollbackLines?: number;
  fgColor?: number;
  bgColor?: number;
  cursorColor?: number;
  /** The 16 ANSI colours; an undefined entry keeps Ghostty's default. */
  palette?: (number | undefined)[];
  /**
   * The default cursor shape and blink, which DECSCUSR Ps 0 and RIS restore. Default
   * block, not blinking. (webtty, ADR 049)
   */
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  /**
   * Whether programs may write the clipboard (OSC 52, OSC 1337 Copy, OSC 5522): the
   * writes are reported by `readEffects`. Off, Ghostty's clipboard write callback is
   * left unset and the writes are ignored. Default true. (webtty, ADR 052)
   */
  clipboardWrite?: boolean;
  /**
   * Whether programs may ask for desktop notifications (OSC 9, OSC 777 `notify`): they
   * are reported by `readEffects`. Off, Ghostty's desktop notification callback is left
   * unset and the requests are ignored. Default true. (webtty, ADR 056)
   */
  desktopNotifications?: boolean;
}

/** A mouse button as Ghostty names it: four/five are the wheel, eight/nine back/forward. */
export type MouseButton = 'left' | 'middle' | 'right' | 'four' | 'five' | 'eight' | 'nine';

/** One mouse event for `encodeMouse` (ADR 049). */
export interface MouseInput {
  action: 'press' | 'release' | 'motion';
  /** The button pressed or released, or the lowest one held for motion; null for none. */
  button: MouseButton | null;
  /** `Mods` bits; Ghostty reports Shift, Alt and Ctrl. */
  mods: number;
  /** Position in the units of `MouseGeometry`, from the screen's top-left corner. */
  x: number;
  y: number;
  /** Whether a button is held after this event: motion outside the screen is reported only then. */
  anyButtonPressed: boolean;
}

/**
 * The surface the mouse encoder maps positions on (ADR 049): the screen is the
 * grid plus the padding around it, in whole pixels, with a whole cell size.
 */
export interface MouseGeometry {
  screenWidth: number;
  screenHeight: number;
  cellWidth: number;
  cellHeight: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
}

/**
 * A cell by screen row (ADR 050): row 0 is the oldest scrollback row and
 * `getScrollbackLength()` the top row of the active screen, as Ghostty's `SCREEN` points.
 */
export interface ScreenCell {
  col: number;
  row: number;
}

/** A range of cells in screen rows, both ends inclusive. */
export interface ScreenRange {
  start: ScreenCell;
  end: ScreenCell;
}

/** Where a search is (ADR 055): its match count and the selected match's index, 0 the newest. */
export interface SearchState {
  total: number;
  selected: number | null;
}

/** A desktop notification a program asked for (OSC 9, OSC 777). (webtty, ADR 056) */
export interface DesktopNotification {
  /** `''` when the sequence has none (OSC 9). */
  title: string;
  body: string;
}

/**
 * Bell, title, clipboard writes and desktop notifications since the last `readEffects`
 * (ADR 042, ADR 052, ADR 056).
 */
export interface TerminalEffects {
  bell: boolean;
  title: string | null;
  /**
   * The text of the last clipboard write the program made (OSC 52, OSC 1337 Copy or
   * OSC 5522) to the standard clipboard, `''` for a clear, or null for none. Only set
   * while the terminal was created with `clipboardWrite` on. (webtty, ADR 052)
   */
  clipboard: string | null;
  /**
   * The desktop notifications the program asked for (OSC 9 and OSC 777 `notify`), in
   * order. Only set while the terminal was created with `desktopNotifications` on.
   * (webtty, ADR 056)
   */
  notifications: DesktopNotification[];
}

/**
 * The terminal surface the renderer, selection, buffer, input handler and
 * terminal.ts use. `getLine(n)`, `getViewport`, `getCursor` and `isRowDirty(n)`
 * use active-screen rows, and `getScrollbackLine(i)` counts from the oldest
 * scrollback row.
 */
export interface GhosttyTerminal {
  readonly cols: number;
  readonly rows: number;

  // Lifecycle
  write(data: string | Uint8Array): void;
  /**
   * Writes the shortest start of `data` that brings the parser to ground, outside any
   * sequence (ESC, CSI, OSC, DCS, UTF-8), and returns its length: 0 when already there.
   * Null when all of `data` was written without reaching it. (ADR 054)
   */
  writeUntilGround(data: Uint8Array): number | null;
  /** Grid resize, with the device-pixel cell size for size reports when known. */
  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): void;
  /** Device-pixel cell size for size reports. */
  setCellPixelSize(cellWidthPx: number, cellHeightPx: number): void;
  /**
   * The default cursor shape and blink (DECSCUSR Ps 0, RIS). They show at once only
   * while the app has not set a shape. (ADR 049)
   */
  setDefaultCursor(style: RenderStateCursor['style'], blink: boolean): void;
  /**
   * The view's `viewportY` (lines scrolled up from the bottom). The renderer calls
   * it first in every render.
   */
  setViewportOffset(linesFromBottom: number): void;
  free(): void;

  // Render state
  update(): DirtyState;
  getCursor(): RenderStateCursor;
  isRowDirty(y: number): boolean;
  markClean(): void;
  getViewport(): GhosttyCell[];
  getLine(y: number): GhosttyCell[] | null;
  needsFullRedraw(): boolean;
  clearDirty(): void;
  getDimensions(): { cols: number; rows: number };

  // Modes
  isAlternateScreen(): boolean;
  hasMouseTracking(): boolean;
  getMode(mode: number, isAnsi?: boolean): boolean;
  /**
   * Whether the cursor is at a shell prompt or its input, from OSC 133 marks; false
   * without them and on the alternate screen. (ADR 054)
   */
  cursorAtPrompt(): boolean;
  /**
   * Ghostty's `jump_to_prompt`: the top row (a screen row, 0 = oldest scrollback row) of
   * a view whose top row is `top` after moving it by `delta` OSC 133 prompts (negative
   * is up). Ghostty's own viewport is left at the bottom. (ADR 057)
   */
  promptJumpRow(top: number, delta: number): number;

  // Scrollback, graphemes, hyperlinks
  getScrollbackLength(): number;
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  isRowWrapped(row: number): boolean;
  getHyperlinkUri(row: number, col: number): string | null;
  getScrollbackHyperlinkUri(offset: number, col: number): string | null;
  getGraphemeString(row: number, col: number): string;
  getScrollbackGraphemeString(offset: number, col: number): string;

  // Selection (ADR 050), in screen rows on the active screen
  /** The word at a cell by Ghostty's word boundaries, soft wraps followed; null if empty. */
  selectWord(cell: ScreenCell): ScreenRange | null;
  /** The line at a cell, soft wraps followed and outer whitespace left out; null when blank. */
  selectLine(cell: ScreenCell): ScreenRange | null;
  /**
   * The output of the command at a cell, from OSC 133 marks (Ghostty's `selectOutput`);
   * null outside command output or without marks. (ADR 057)
   */
  selectOutput(cell: ScreenCell): ScreenRange | null;
  /**
   * The text from `start` to `end` (inclusive, in either order) as Ghostty copies it:
   * soft-wrapped rows joined, trailing whitespace trimmed, spacer cells skipped.
   */
  selectionText(start: ScreenCell, end: ScreenCell): string;

  // Search (ADR 055), Ghostty's, on the active screen, scrollback included
  /**
   * Sets the text to find, matched as Ghostty does: ASCII letters case-insensitively,
   * the rest exactly, soft-wrapped rows joined. `''` ends the search.
   */
  setSearch(needle: string): void;
  /**
   * Catches the search up with the terminal, working for at most about `budgetMs`.
   * Returns whether the results may have changed.
   */
  searchStep(budgetMs: number): boolean;
  /** Selects the next match (toward older output) or the previous one, wrapping; false if none. */
  searchSelect(direction: 'next' | 'previous'): boolean;
  searchState(): SearchState;
  /** The selected match in screen rows, or null. */
  searchSelectedMatch(): ScreenRange | null;
  /**
   * Every match, newest to oldest, as screen rows: start col, start row, end col, end
   * row per match, both ends inclusive.
   */
  searchMatches(): Int32Array;

  // Mouse reports (ADR 049)
  /** The geometry `encodeMouse` positions are in. */
  setMouseGeometry(geometry: MouseGeometry): void;
  /**
   * A mouse event as the app asked for it (tracking mode and format), or no bytes when
   * it is not reported: motion within the last reported cell, motion the mode does not
   * report, or motion outside the screen with no button held.
   */
  encodeMouse(input: MouseInput): Uint8Array;

  // Focus reports (ADR 053)
  /** The mode 1004 report for a focus change, `CSI I` or `CSI O`, as Ghostty encodes it. */
  encodeFocus(focused: boolean): Uint8Array;

  // Paste (ADR 049)
  /**
   * Pastes text as Ghostty does (`ghostty_terminal_paste`): bracketed while mode 2004
   * is on, unsafe control bytes replaced with spaces, newlines sent as CR without 2004.
   * The bytes are queued as a reply, read with `readResponse`.
   */
  paste(text: string): void;

  // Replies and effects
  hasResponse(): boolean;
  readResponse(): string | null;
  /** Bell, title, clipboard writes and desktop notifications since the last call. */
  readEffects(): TerminalEffects;
}

/** Converts keyboard events into terminal escape sequences. */
export interface KeyEncoder {
  setOption(option: KeyEncoderOption, value: boolean | number): void;
  encode(event: KeyEvent): Uint8Array;
  dispose(): void;
}

/**
 * What the engine's bindings need from the loaded wasm instance, `Ghostty`, so they
 * import this interface instead of the facade (ADR 061).
 */
export interface EngineHost {
  /** The wasm exports. */
  readonly ex: OfficialWasmExports;
  /** The manifest's offsets and enum values, resolved per feature. */
  readonly L: OfficialLayout;
  /** One function table per instance; terminals install their callbacks in it. */
  readonly fnTable: FnTable;
  /** ghostty-web `Key` value → official `GhosttyKey` value. */
  readonly keys: ReadonlyMap<number, number>;
  /** ghostty-web `KeyEncoderOption` → official `GhosttyKeyEncoderOption`. */
  readonly encoderOptions: ReadonlyMap<number, number>;
  /** ghostty-web `KeyAction` → official `GhosttyKeyAction`. */
  readonly keyActions: ReadonlyMap<number, number>;
  /** The official `GhosttyKey` for a key with no translation. */
  readonly unidentifiedKey: number;
  /** Creates an object through a `GhosttyFoo* out` slot and returns its handle. */
  newHandle(what: string, create: (slot: number) => number): number;
}
