// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// What the canvas renderer reads and what its painters share (types): its options and
// deps, the screen buffer, the scrollback, one row's content, the paint settings, the draw
// counter and the frame's decorations. The render parts import these instead of each
// other or the facade (ADR 061).

import type { GhosttyCell } from '../engine/cell-types';
import type { ITheme } from '../interfaces';
import type { HighlightSpan } from '../search';
import type { CellRange } from './cell-range';
import type { FontMetrics } from './font-metrics';

/** The cursor's shapes. */
export type CursorStyle = 'block' | 'underline' | 'bar';

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

/**
 * What every painter draws with, shared by reference so a font, theme or ratio change
 * made on the renderer reaches them all at once. (webtty, ADR 061)
 */
export interface PaintSettings {
  fontSize: number;
  fontFamily: string;
  metrics: FontMetrics;
  theme: Required<ITheme>;
  /** The whole ratio the canvas backing store is drawn at. */
  devicePixelRatio: number;
}

/**
 * Counts the calls that draw on the canvas. Every painter bumps it, so the renderer's
 * `visibleArea.version` changes whenever the pixels may have. (webtty, ADR 043, ADR 061)
 */
export interface DrawCounter {
  draws: number;
}

/**
 * What one frame draws over the cells' own colours, in canvas rows: the selection, the
 * search match spans per canvas row, and the hovered link's range. The renderer sets it
 * before it paints a row. (webtty, ADR 043, ADR 055)
 */
export interface FrameDecorations {
  selection: CellRange | null;
  searchSpans: (HighlightSpan[] | undefined)[];
  link: CellRange | null;
}

/** Paints one canvas row on the context it is given (the canvas' or the scratch canvas'). */
export interface RowPainter {
  paintRow(ctx: CanvasRenderingContext2D, k: number, cols: number, content: RowContent): void;
}

/** Paints one cell's text and decorations, in `colorOverride` when given (the block cursor). */
export interface CellTextPainter {
  paintCellText(
    ctx: CanvasRenderingContext2D,
    cell: GhosttyCell,
    x: number,
    y: number,
    colorOverride: string | undefined,
    grapheme: GraphemeLookup
  ): void;
}

/** The interval timer the blink runs on; the window's in the browser, a manual clock in tests. */
export interface IntervalTimers {
  setInterval(run: () => void, ms: number): number;
  clearInterval(id: number): void;
}

/** What a terminal configures the renderer with; the engine's cursor shape wins over the option. */
export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: CursorStyle; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio, rounded up and followed
  // Rows drawn above and below the viewport. Default: DEFAULT_OVERSCAN (webtty, ADR 043)
  overscan?: number;
}

/**
 * The globals the renderer uses, injectable for tests; each defaults to the browser's.
 * (webtty, ADR 061)
 */
export interface RendererDeps {
  /** Creates the drawing, scratch and font-measuring canvases, in that order. */
  document?: Pick<Document, 'createElement'>;
  /** Read for the ratio, and watched for its changes, when no ratio option is given. */
  window?: Pick<Window, 'devicePixelRatio' | 'matchMedia'>;
  /** The cursor blink's interval timer. */
  timers?: IntervalTimers;
}
