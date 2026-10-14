// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// What the canvas renderer reads (types): the screen buffer, the scrollback and one row's
// content. The render parts import these instead of the terminal or the engine (ADR 061).

import type { GhosttyCell } from '../engine/cell-types';

/** The screen buffer the renderer draws: the engine's terminal, or a test double. */
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  /**
   * All viewport cells, row-major, read in one call. The array may be reused by
   * the next call, so rows taken from it are only valid until then.
   */
  getViewport?(): GhosttyCell[];
  /**
   * The view's `viewportY` (lines scrolled up from the bottom). `render` calls it
   * first, so every render path syncs the terminal's view offset in one place.
   * Optional for buffers that cannot scroll. (webtty, ADR 042)
   */
  setViewportOffset?(linesFromBottom: number): void;
  /**
   * The cursor. `style` and `blinking`, when given, are the shape and blink the engine
   * reports (DECSCUSR over the configured default) and are drawn instead of the
   * options. (webtty, ADR 049)
   */
  getCursor(): {
    x: number;
    y: number;
    visible: boolean;
    style?: 'block' | 'underline' | 'bar';
    blinking?: boolean;
  };
  getDimensions(): { cols: number; rows: number };
  isRowDirty(y: number): boolean;
  /** Returns true if a full redraw is needed (e.g., screen change) */
  needsFullRedraw?(): boolean;
  clearDirty(): void;
  /**
   * Get the full grapheme string for a cell at (row, col).
   * For cells with grapheme_len > 0, this returns all codepoints combined.
   * For simple cells, returns the single character.
   */
  getGraphemeString?(row: number, col: number): string;
}

/** The scrollback rows above the screen, counted from the oldest; the terminal provides them. */
export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
  /** Full grapheme string for a scrollback cell, as getGraphemeString for screen rows. */
  getScrollbackGraphemeString?(offset: number, col: number): string;
}

/** Looks up the full grapheme string for a column of the line being drawn. */
export type GraphemeLookup = (col: number) => string;

/**
 * What one canvas row shows: its line (null past the buffer's ends, drawn blank) and the
 * grapheme lookup on the same source, since a canvas row is not a screen row while
 * scrolled. (webtty, ADR 043)
 */
export interface RowContent {
  line: GhosttyCell[] | null;
  grapheme?: GraphemeLookup;
}
