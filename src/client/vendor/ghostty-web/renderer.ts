/**
 * Canvas Renderer for Terminal Display
 *
 * High-performance canvas-based renderer that draws the terminal using
 * Ghostty's WASM terminal emulator. Features:
 * - Font metrics measurement with DPI scaling
 * - Full color support (256-color palette + RGB)
 * - All text styles (bold, italic, underline, strikethrough, etc.)
 * - Multiple cursor styles (block, underline, bar)
 * - Dirty line optimization for 60 FPS
 */

import type { ITheme } from './interfaces';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell, ILink } from './types';
import { CellFlags } from './types';

// Interface for objects that can be rendered
export interface IRenderable {
  getLine(y: number): GhosttyCell[] | null;
  /**
   * All viewport cells, row-major, read in one call. The array may be reused by
   * the next call, so rows taken from it are only valid until then.
   */
  getViewport?(): GhosttyCell[];
  /**
   * The view's `viewportY` (lines scrolled up from the bottom). `render` calls it
   * first, so every render path syncs the engine's viewport in one place. Only the
   * official engine implements it. (webtty, ADR 042)
   */
  setViewportOffset?(linesFromBottom: number): void;
  getCursor(): { x: number; y: number; visible: boolean };
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

export interface IScrollbackProvider {
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  getScrollbackLength(): number;
  /** Full grapheme string for a scrollback cell, as getGraphemeString for screen rows. */
  getScrollbackGraphemeString?(offset: number, col: number): string;
}

/** Looks up the full grapheme string for a column of the line being drawn. */
export type GraphemeLookup = (col: number) => string;

// ============================================================================
// Type Definitions
// ============================================================================

export interface RendererOptions {
  fontSize?: number; // Default: 15
  fontFamily?: string; // Default: 'monospace'
  cursorStyle?: 'block' | 'underline' | 'bar'; // Default: 'block'
  cursorBlink?: boolean; // Default: false
  theme?: ITheme;
  devicePixelRatio?: number; // Default: window.devicePixelRatio, rounded up and followed
}

/**
 * The ratio the canvas is drawn at: the device pixel ratio rounded up to a whole
 * number. A fractional ratio (browser zoom, Windows 125%/150%) would put cell edges
 * between device pixels and make the backing-store size fractional; the browser
 * scales the whole-ratio canvas down instead (coder/ghostty-web#198). Browsers
 * report some whole ratios with float noise (2.0000000298023224), which must not
 * round up to the next whole ratio.
 */
export function wholeDevicePixelRatio(ratio: number | undefined): number {
  return Math.max(1, Math.ceil((ratio || 1) - 1e-3));
}

/**
 * Calls onChange with the new window.devicePixelRatio whenever it changes (moving
 * to a display with a different scale, browser zoom). A resolution media query
 * only matches one ratio, so it is re-armed for each new ratio. Returns a function
 * that stops watching.
 */
export function watchDevicePixelRatio(
  win: Pick<Window, 'devicePixelRatio' | 'matchMedia'>,
  onChange: (ratio: number) => void
): () => void {
  let stop = () => {};
  const arm = () => {
    if (typeof win.matchMedia !== 'function') return;
    const query = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    const listener = () => {
      onChange(win.devicePixelRatio || 1);
      arm();
    };
    query.addEventListener('change', listener, { once: true });
    stop = () => query.removeEventListener('change', listener);
  };
  arm();
  return () => stop();
}

/**
 * Returns a row reader for one frame. When the buffer has getViewport, the
 * viewport is read once, on the first row asked for, and every row is a slice of
 * that snapshot; getLine copies and parses the whole viewport on each call.
 */
export function frameLines(
  buffer: Pick<IRenderable, 'getLine' | 'getViewport'>,
  cols: number,
  rows: number
): (y: number) => GhosttyCell[] | null {
  if (!buffer.getViewport) return (y) => buffer.getLine(y);
  let viewport: GhosttyCell[] | null = null;
  return (y) => {
    if (y < 0 || y >= rows) return null;
    viewport ??= buffer.getViewport!();
    return viewport.slice(y * cols, (y + 1) * cols);
  };
}

export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

// ============================================================================
// Default Theme
// ============================================================================

export const DEFAULT_THEME: Required<ITheme> = {
  foreground: '#d4d4d4',
  background: '#1e1e1e',
  cursor: '#ffffff',
  cursorAccent: '#1e1e1e',
  // Selection colors: solid colors that replace cell bg/fg when selected
  // Using Ghostty's approach: selection bg = default fg, selection fg = default bg
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private fontSize: number;
  private fontFamily: string;
  private cursorStyle: 'block' | 'underline' | 'bar';
  private cursorBlink: boolean;
  private theme: Required<ITheme>;
  private _devicePixelRatio: number;
  private stopWatchingDevicePixelRatio?: () => void;
  private metrics: FontMetrics;
  private palette: string[];

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  // Where the last frame drew the cursor: its canvas row (-1: not drawn) and column (webtty)
  private cursorRow: number = -1;
  private cursorCol: number = 0;
  // Cursor style or blink changed since the last frame: repaint the cursor cell so
  // the old shape does not stay under the new one (webtty)
  private cursorShapeChanged: boolean = false;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;
  private lastScrollbackLength: number = 0;

  // The canvas no longer matches its rows (theme, font or ratio change); the next frame
  // repaints every row (webtty, ADR 043)
  private canvasStale: boolean = false;
  // The last frame painted the scrollbar over the right edge of the rows (webtty, ADR 043)
  private scrollbarPainted: boolean = false;
  // The browser restored a lost context: the backing store is blank and the context
  // state reset, so the next frame resizes and repaints every row (webtty, ADR 043)
  private contextRestored: boolean = false;
  private readonly onContextRestored = () => {
    this.contextRestored = true;
  };
  // A partial repaint draws its rows here, unclipped, then copies them into the canvas
  // (webtty, ADR 043; see repaintRows)
  private readonly scratch: HTMLCanvasElement;

  // Current buffer being rendered (for grapheme lookups)
  private currentBuffer: IRenderable | null = null;
  // Row reader for the current render pass (one viewport read per frame)
  private currentLine: (y: number) => GhosttyCell[] | null = () => null;

  // Selection manager (for rendering selection)
  private selectionManager?: SelectionManager;
  // Cached selection coordinates for current render pass (viewport-relative)
  private currentSelectionCoords: {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
  } | null = null;

  // Link rendering state
  private hoveredHyperlinkId: number = 0;
  private previousHoveredHyperlinkId: number = 0;

  // Regex link hover tracking (for links without hyperlink_id)
  private hoveredLinkRange: { startX: number; startY: number; endX: number; endY: number } | null =
    null;
  private previousHoveredLinkRange: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  } | null = null;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;
    // Frames only draw what changed, so a canvas the browser blanked would stay blank
    // (webtty, ADR 043)
    canvas.addEventListener('contextrestored', this.onContextRestored);
    this.scratch = document.createElement('canvas');
    this.scratch.width = 0;
    this.scratch.height = 0;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this._devicePixelRatio = wholeDevicePixelRatio(
      options.devicePixelRatio ?? window.devicePixelRatio
    );
    // Follow ratio changes; the next render() sees the backing-store mismatch and
    // resizes and repaints the canvas.
    if (options.devicePixelRatio === undefined) {
      this.stopWatchingDevicePixelRatio = watchDevicePixelRatio(window, (ratio) => {
        this._devicePixelRatio = wholeDevicePixelRatio(ratio);
        this.canvasStale = true;
      });
    }

    // Build color palette (16 ANSI colors)
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];

    // Measure font metrics
    this.metrics = this.measureFont();

    // Setup cursor blinking if enabled
    if (this.cursorBlink) {
      this.startCursorBlink();
    }
  }

  /** The whole ratio the canvas backing store is drawn at. */
  public get devicePixelRatio(): number {
    return this._devicePixelRatio;
  }

  // ==========================================================================
  // Font Metrics Measurement
  // ==========================================================================

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Set font (use actual pixel size for accurate measurement)
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;

    // Measure width using 'M' (typically widest character)
    const widthMetrics = ctx.measureText('M');
    const width = Math.ceil(widthMetrics.width);

    // Measure height using ascent + descent with padding for glyph overflow
    const ascent = widthMetrics.actualBoundingBoxAscent || this.fontSize * 0.8;
    const descent = widthMetrics.actualBoundingBoxDescent || this.fontSize * 0.2;

    // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
    // and anti-aliasing pixels
    const height = Math.ceil(ascent + descent) + 2;
    const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

    return { width, height, baseline };
  }

  /**
   * Remeasure font metrics (call after font loads or changes)
   */
  public remeasureFont(): void {
    this.metrics = this.measureFont();
    this.canvasStale = true;
  }

  // ==========================================================================
  // Color Conversion
  // ==========================================================================

  private rgbToCSS(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
  }

  // ==========================================================================
  // Canvas Sizing
  // ==========================================================================

  /**
   * Resize canvas to fit terminal dimensions
   */
  public resize(cols: number, rows: number): void {
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees)
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Set actual canvas size (scaled for DPI)
    this.canvas.width = Math.round(cssWidth * this.devicePixelRatio);
    this.canvas.height = Math.round(cssHeight * this.devicePixelRatio);

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, cssHeight);
    this.canvasStale = true;
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   *
   * Only the canvas rows that changed are repainted. When the viewport moves by whole
   * lines and nothing else changed, the rows still in view are copied to their new place
   * with one drawImage of the canvas onto itself and only the rows that came into view
   * are drawn. A partial frame leaves the canvas exactly as a full redraw would (webtty,
   * ADR 043; see repaintRows).
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Move the engine's viewport to the view before any read (webtty, ADR 042)
    buffer.setViewportOffset?.(viewportY);

    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    const dims = buffer.getDimensions();
    const getLine = frameLines(buffer, dims.cols, dims.rows);
    this.currentLine = getLine;
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.contextRestored ||
      this.canvas.width !== Math.round(dims.cols * this.metrics.width * this.devicePixelRatio) ||
      this.canvas.height !== Math.round(dims.rows * this.metrics.height * this.devicePixelRatio);

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      this.contextRestored = false;
      forceAll = true; // Force full render after resize
    }

    // A theme, font or ratio change since the last frame changes every row (webtty, ADR 043)
    if (this.canvasStale) {
      forceAll = true;
      this.canvasStale = false;
    }

    // The scrollbar is painted over the right edge of every row, so a frame that does not
    // paint it repaints every row: none keeps the old thumb (webtty, ADR 043)
    const paintsScrollbar = !!scrollbackProvider && scrollbarOpacity > 0;
    if (this.scrollbarPainted && !paintsScrollbar) {
      forceAll = true;
    }

    // Check if we need to redraw selection-related lines
    const hasSelection = this.selectionManager && this.selectionManager.hasSelection();
    const selectionRows = new Set<number>();

    // Cache selection coordinates for use during cell rendering
    // This is used by isInSelection() to determine if a cell needs selection colors
    this.currentSelectionCoords = hasSelection ? this.selectionManager!.getSelectionCoords() : null;

    // Mark current selection rows for redraw (includes programmatic selections)
    if (this.currentSelectionCoords) {
      const coords = this.currentSelectionCoords;
      for (let row = coords.startRow; row <= coords.endRow; row++) {
        selectionRows.add(row);
      }
    }

    // Always mark dirty selection rows for redraw (to clear old overlay). They were
    // marked at the viewport of their time, so a viewport move with any of them
    // repaints every row (webtty, ADR 043)
    let selectionDirty = false;
    if (this.selectionManager) {
      const dirtyRows = this.selectionManager.getDirtySelectionRows();
      if (dirtyRows.size > 0) {
        selectionDirty = true;
        for (const row of dirtyRows) {
          selectionRows.add(row);
        }
        // Clear the dirty rows tracking after marking for redraw
        this.selectionManager.clearDirtySelectionRows();
      }
    }

    // Track rows with hyperlinks that need redraw when hover changes
    const hyperlinkRows = new Set<number>();
    const hyperlinkChanged = this.hoveredHyperlinkId !== this.previousHoveredHyperlinkId;
    const linkRangeChanged =
      JSON.stringify(this.hoveredLinkRange) !== JSON.stringify(this.previousHoveredLinkRange);
    // The regex link underline the last frame drew (webtty, ADR 043)
    const drawnLinkRange = this.previousHoveredLinkRange;

    if (hyperlinkChanged) {
      // Find rows containing the old or new hovered hyperlink
      // Must check the correct buffer based on viewportY (scrollback vs screen)
      for (let y = 0; y < dims.rows; y++) {
        let line: GhosttyCell[] | null = null;

        // Same logic as rendering: fetch from scrollback or screen
        if (viewportY > 0) {
          if (y < viewportY && scrollbackProvider) {
            // This row is from scrollback
            // Floor viewportY for array access (handles fractional values during smooth scroll)
            const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
            line = scrollbackProvider.getScrollbackLine(scrollbackOffset);
          } else {
            // This row is from visible screen
            const screenRow = y - Math.floor(viewportY);
            line = getLine(screenRow);
          }
        } else {
          // At bottom - fetch from visible screen
          line = getLine(y);
        }

        if (line) {
          for (const cell of line) {
            if (
              cell.hyperlink_id === this.hoveredHyperlinkId ||
              cell.hyperlink_id === this.previousHoveredHyperlinkId
            ) {
              hyperlinkRows.add(y);
              break; // Found hyperlink in this row
            }
          }
        }
      }
      // Update previous state
      this.previousHoveredHyperlinkId = this.hoveredHyperlinkId;
    }

    // Track rows affected by link range changes (for regex URLs)
    if (linkRangeChanged) {
      // Add rows from old range
      if (this.previousHoveredLinkRange) {
        for (
          let y = this.previousHoveredLinkRange.startY;
          y <= this.previousHoveredLinkRange.endY;
          y++
        ) {
          hyperlinkRows.add(y);
        }
      }
      // Add rows from new range
      if (this.hoveredLinkRange) {
        for (let y = this.hoveredLinkRange.startY; y <= this.hoveredLinkRange.endY; y++) {
          hyperlinkRows.add(y);
        }
      }
      this.previousHoveredLinkRange = this.hoveredLinkRange;
    }

    // Rows the engine changed. They are screen rows, which are canvas rows only at the
    // bottom; while scrolled, any change repaints every row. (webtty, ADR 043)
    const dirtyRows: number[] = [];
    if (!forceAll) {
      for (let y = 0; y < dims.rows; y++) {
        if (buffer.isRowDirty(y)) dirtyRows.push(y);
      }
    }

    // Canvas rows the kept rows moved down by (up when negative) this frame
    let shift = 0;
    if (viewportY !== this.lastViewportY) {
      // The viewport moved. When only the viewport moved, by whole lines and by less than
      // a screen, copy the rows still in view to their new place; otherwise repaint
      // every row as before. (webtty, ADR 043)
      const moved = viewportY - this.lastViewportY;
      const onlyViewportMoved =
        !forceAll &&
        Number.isInteger(viewportY) &&
        Number.isInteger(this.lastViewportY) &&
        Math.abs(moved) < dims.rows &&
        scrollbackLength === this.lastScrollbackLength &&
        dirtyRows.length === 0 &&
        !selectionDirty;
      if (onlyViewportMoved) {
        this.shiftRows(moved);
        shift = moved;
      } else {
        forceAll = true;
      }
      this.lastViewportY = viewportY;
    } else if (
      viewportY > 0 &&
      (dirtyRows.length > 0 || scrollbackLength !== this.lastScrollbackLength)
    ) {
      forceAll = true;
    }
    this.lastScrollbackLength = scrollbackLength;

    // Canvas rows whose pixels are repainted. A row whose content or highlight changed
    // also repaints the row above, which its glyphs may overflow into.
    const rows = dims.rows;
    const repaint = new Uint8Array(rows);
    const region = (y: number) => {
      if (y >= 0 && y < rows) repaint[y] = 1;
    };
    const changed = (y: number) => {
      region(y);
      region(y - 1);
    };
    if (forceAll) {
      repaint.fill(1);
    } else {
      for (const y of dirtyRows) changed(y);
      for (const y of selectionRows) changed(y);
      for (const y of hyperlinkRows) changed(y);
      if (shift > 0) {
        // Rows came into view at the top. The last row lost the row below it, whose
        // glyphs overflowed into it.
        for (let y = 0; y < shift; y++) changed(y);
        region(rows - 1);
      } else if (shift < 0) {
        // Rows came into view at the bottom
        for (let y = rows + shift; y < rows; y++) changed(y);
      }
      if (shift !== 0) {
        // A regex link underline is drawn at fixed canvas rows, so it did not move with
        // the rows: clear it where the copy moved it and draw it where it is.
        for (const range of [drawnLinkRange, this.hoveredLinkRange]) {
          if (!range) continue;
          for (let y = range.startY; y <= range.endY; y++) {
            changed(y);
            changed(y + shift);
          }
        }
      }
    }

    // The cursor is drawn over its cell after the rows. Repaint the cell the last frame's
    // cursor is in now unless the same cursor is drawn there again.
    const drawsCursor = viewportY === 0 && cursor.visible && this.cursorVisible;
    let sameCursor = false;
    if (this.cursorRow >= 0) {
      const row = this.cursorRow + shift;
      sameCursor =
        drawsCursor && row === cursor.y && cursor.x === this.cursorCol && !this.cursorShapeChanged;
      if (!sameCursor) region(row);
    }
    this.cursorShapeChanged = false;
    // The same cursor over an unrepainted row is still on the canvas. Drawing it again
    // would blend a translucent cursor colour over itself until it is opaque.
    const cursorKept = sameCursor && !repaint[cursor.y];

    // Repaint each run of rows
    for (let y = 0; y < rows; y++) {
      if (!repaint[y]) continue;
      let end = y;
      while (end + 1 < rows && repaint[end + 1]) end++;
      this.repaintRows(y, end, dims.cols, rows, (row) =>
        this.rowAt(row, viewportY, getLine, buffer, scrollbackProvider, scrollbackLength)
      );
      y = end;
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if we're at the bottom, not scrolled)
    if (drawsCursor && !cursorKept) {
      this.renderCursor(cursor.x, cursor.y);
    }
    this.cursorRow = drawsCursor ? cursor.y : -1;
    this.cursorCol = cursor.x;

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (paintsScrollbar) {
      this.renderScrollbar(viewportY, scrollbackLength, dims.rows, scrollbarOpacity);
    }
    this.scrollbarPainted = paintsScrollbar;

    // Without scrollback rows a scrolled frame left its top rows unpainted
    if (viewportY > 0 && !scrollbackProvider) this.canvasStale = true;

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * The line shown at canvas row `y`, from scrollback or the screen, with a grapheme
   * lookup on the same source: canvas row y is not screen row y while scrolled. (webtty)
   */
  private rowAt(
    y: number,
    viewportY: number,
    getLine: (y: number) => GhosttyCell[] | null,
    buffer: IRenderable,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbackLength: number
  ): { line: GhosttyCell[] | null; grapheme?: GraphemeLookup } {
    if (viewportY > 0) {
      // Scrolled up - need to fetch from scrollback + visible screen
      // When scrolled up N lines, we want to show:
      // - Scrollback lines (from the end) + visible screen lines

      // Check if this row should come from scrollback or visible screen
      if (y < viewportY && scrollbackProvider) {
        // This row is from scrollback (upper part of viewport)
        // Get from end of scrollback buffer
        // Floor viewportY for array access (handles fractional values during smooth scroll)
        const scrollbackOffset = scrollbackLength - Math.floor(viewportY) + y;
        return {
          line: scrollbackProvider.getScrollbackLine(scrollbackOffset),
          grapheme: this.scrollbackGraphemes(scrollbackProvider, scrollbackOffset),
        };
      }
      // This row is from visible screen (lower part of viewport)
      const screenRow = y - Math.floor(viewportY);
      return { line: getLine(screenRow), grapheme: this.screenGraphemes(buffer, screenRow) };
    }
    // At bottom - fetch from visible screen
    return { line: getLine(y) };
  }

  /**
   * Repaints canvas rows `first` to `last` exactly as a full redraw leaves them. A full
   * redraw draws every row in order, each clearing its own cell area first, so a row's
   * pixels are its own cells plus whatever the row below draws over it (tall glyphs,
   * combining marks); what the row above overflows into it is cleared. So the rows are
   * drawn in order, plus the row below the last.
   *
   * A run short of the whole canvas is drawn on the scratch canvas and its rows copied
   * into the canvas. Drawing it clipped to the run is not the same: Chrome skips a glyph
   * whose box is outside the clip, so a combining mark of the row below loses the
   * antialiased edge it draws on the run's last pixel line. (webtty, ADR 043)
   */
  private repaintRows(
    first: number,
    last: number,
    cols: number,
    rows: number,
    rowAt: (y: number) => { line: GhosttyCell[] | null; grapheme?: GraphemeLookup }
  ): void {
    const whole = first === 0 && last === rows - 1;
    const own = this.ctx;
    const scratch = whole ? null : this.scratchContext();
    if (scratch) this.ctx = scratch;
    try {
      for (let y = first; y <= Math.min(last + 1, rows - 1); y++) {
        const { line, grapheme } = rowAt(y);
        if (line) {
          this.renderLine(line, y, cols, grapheme);
        }
      }
    } finally {
      this.ctx = own;
    }
    if (!scratch) return;
    // Replace the rows' pixels in device pixels: cleared first, the copy is not blended
    // over them, so a translucent background does not darken
    const width = this.canvas.width;
    const rowHeight = this.metrics.height * this.devicePixelRatio;
    const top = first * rowHeight;
    const height = (last - first + 1) * rowHeight;
    own.save();
    own.setTransform(1, 0, 0, 1, 0, 0);
    own.globalAlpha = 1;
    own.globalCompositeOperation = 'source-over';
    own.imageSmoothingEnabled = false;
    own.clearRect(0, top, width, height);
    own.drawImage(this.scratch, 0, top, width, height, 0, top, width, height);
    own.restore();
  }

  /** The scratch canvas' context, sized and scaled like the canvas. (webtty, ADR 043) */
  private scratchContext(): CanvasRenderingContext2D {
    const { width, height } = this.canvas;
    if (this.scratch.width !== width) this.scratch.width = width;
    if (this.scratch.height !== height) this.scratch.height = height;
    const ctx = this.scratch.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    // Set every time: resizing, or a lost context, resets the context state
    ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    return ctx;
  }

  /**
   * Moves the canvas content down by `rows` rows (up when negative) with one drawImage of
   * the canvas onto itself, in device pixels. The 'copy' operator replaces pixels instead
   * of blending onto them (a translucent background would darken) and clears the rest of
   * the canvas: the rows that came into view, which are all repainted. (webtty, ADR 043)
   */
  private shiftRows(rows: number): void {
    const { width, height } = this.canvas;
    const dy = rows * this.metrics.height * this.devicePixelRatio;
    const kept = height - Math.abs(dy);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.canvas,
      0,
      Math.max(0, -dy),
      width,
      kept,
      0,
      Math.max(0, dy),
      width,
      kept
    );
    ctx.restore();
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  private renderLine(
    line: GhosttyCell[],
    y: number,
    cols: number,
    grapheme: GraphemeLookup = this.screenGraphemes(this.currentBuffer, y)
  ): void {
    const lineY = y * this.metrics.height;
    const lineWidth = cols * this.metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing adjacent rows (see render() method).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, lineY, lineWidth, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, lineY, lineWidth, this.metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellBackground(cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.renderCellText(cell, x, y, undefined, grapheme);
    }
  }

  /** Grapheme lookup for a screen row. */
  private screenGraphemes(buffer: IRenderable | null, row: number): GraphemeLookup {
    return (col) => buffer?.getGraphemeString?.(row, col) ?? ' ';
  }

  /** Grapheme lookup for a scrollback row. */
  private scrollbackGraphemes(provider: IScrollbackProvider, offset: number): GraphemeLookup {
    return (col) => provider.getScrollbackGraphemeString?.(offset, col) ?? ' ';
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  private renderCellBackground(cell: GhosttyCell, x: number, y: number): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // Extract background color and handle inverse
    let bg_r = cell.bg_r,
      bg_g = cell.bg_g,
      bg_b = cell.bg_b;

    if (cell.flags & CellFlags.INVERSE) {
      // When inverted, background becomes foreground
      bg_r = cell.fg_r;
      bg_g = cell.fg_g;
      bg_b = cell.fg_b;
    }

    // Only draw cell background if it's different from the default (black)
    // This lets the theme background (drawn earlier) show through for default cells
    const isDefaultBg = bg_r === 0 && bg_g === 0 && bg_b === 0;
    if (!isDefaultBg) {
      this.ctx.fillStyle = this.rgbToCSS(bg_r, bg_g, bg_b);
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
    }
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  private renderCellText(
    cell: GhosttyCell,
    x: number,
    y: number,
    colorOverride?: string,
    grapheme: GraphemeLookup = this.screenGraphemes(this.currentBuffer, y)
  ): void {
    const cellX = x * this.metrics.width;
    const cellY = y * this.metrics.height;
    const cellWidth = this.metrics.width * cell.width;

    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) {
      return;
    }

    // Check if this cell is selected
    const isSelected = this.isInSelection(x, y);

    // Set text style
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += 'bold ';
    this.ctx.font = `${fontStyle}${this.fontSize}px ${this.fontFamily}`;

    // Set text color - use override, selection foreground, or normal color
    if (colorOverride) {
      this.ctx.fillStyle = colorOverride;
    } else if (isSelected) {
      this.ctx.fillStyle = this.theme.selectionForeground;
    } else {
      // Extract colors and handle inverse
      let fg_r = cell.fg_r,
        fg_g = cell.fg_g,
        fg_b = cell.fg_b;

      if (cell.flags & CellFlags.INVERSE) {
        // When inverted, foreground becomes background
        fg_r = cell.bg_r;
        fg_g = cell.bg_g;
        fg_b = cell.bg_b;
      }

      this.ctx.fillStyle = this.rgbToCSS(fg_r, fg_g, fg_b);
    }

    // Apply faint effect
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 0.5;
    }

    // Draw text
    const textX = cellX;
    const textY = cellY + this.metrics.baseline;

    // Get the character to render - use grapheme lookup for complex scripts
    let char: string;
    if (cell.grapheme_len > 0) {
      // Cell has additional codepoints - get full grapheme cluster
      char = grapheme(x);
    } else {
      // Simple cell - single codepoint
      char = String.fromCodePoint(cell.codepoint || 32); // Default to space if null
    }
    this.ctx.fillText(char, textX, textY);

    // Reset alpha
    if (cell.flags & CellFlags.FAINT) {
      this.ctx.globalAlpha = 1.0;
    }

    // Draw underline
    if (cell.flags & CellFlags.UNDERLINE) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }

    // Draw strikethrough
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      const strikeY = cellY + this.metrics.height / 2;
      this.ctx.strokeStyle = this.ctx.fillStyle;
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, strikeY);
      this.ctx.lineTo(cellX + cellWidth, strikeY);
      this.ctx.stroke();
    }

    // Draw hyperlink underline (for OSC8 hyperlinks)
    if (cell.hyperlink_id > 0) {
      const isHovered = cell.hyperlink_id === this.hoveredHyperlinkId;

      // Only show underline when hovered (cleaner look)
      if (isHovered) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }

    // Draw regex link underline (for plain text URLs)
    if (this.hoveredLinkRange) {
      const range = this.hoveredLinkRange;
      // Check if this cell is within the hovered link range
      const isInRange =
        (y === range.startY && x >= range.startX && (y < range.endY || x <= range.endX)) ||
        (y > range.startY && y < range.endY) ||
        (y === range.endY && x <= range.endX && (y > range.startY || x >= range.startX));

      if (isInRange) {
        const underlineY = cellY + this.metrics.baseline + 2;
        this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(cellX, underlineY);
        this.ctx.lineTo(cellX + cellWidth, underlineY);
        this.ctx.stroke();
      }
    }
  }

  /**
   * Render cursor
   */
  private renderCursor(x: number, y: number): void {
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const line = this.currentLine(y);
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            this.renderCellText(line[x], x, y, this.theme.cursorAccent);
            this.ctx.restore();
          }
        }
        break;

      case 'underline':
        // Underline at bottom of cell
        const underlineHeight = Math.max(2, Math.floor(this.metrics.height * 0.15));
        this.ctx.fillRect(
          cursorX,
          cursorY + this.metrics.height - underlineHeight,
          this.metrics.width,
          underlineHeight
        );
        break;

      case 'bar':
        // Vertical bar at left of cell
        const barWidth = Math.max(2, Math.floor(this.metrics.width * 0.15));
        this.ctx.fillRect(cursorX, cursorY, barWidth, this.metrics.height);
        break;
    }
  }

  // ==========================================================================
  // Cursor Blinking
  // ==========================================================================

  private startCursorBlink(): void {
    // xterm.js uses ~530ms blink interval
    this.cursorBlinkInterval = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      // Note: Render loop should redraw cursor line automatically
    }, 530);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkInterval !== undefined) {
      clearInterval(this.cursorBlinkInterval);
      this.cursorBlinkInterval = undefined;
    }
    this.cursorVisible = true;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Update theme colors
   */
  public setTheme(theme: ITheme): void {
    this.theme = { ...DEFAULT_THEME, ...theme };
    this.canvasStale = true;

    // Rebuild palette
    this.palette = [
      this.theme.black,
      this.theme.red,
      this.theme.green,
      this.theme.yellow,
      this.theme.blue,
      this.theme.magenta,
      this.theme.cyan,
      this.theme.white,
      this.theme.brightBlack,
      this.theme.brightRed,
      this.theme.brightGreen,
      this.theme.brightYellow,
      this.theme.brightBlue,
      this.theme.brightMagenta,
      this.theme.brightCyan,
      this.theme.brightWhite,
    ];
  }

  /**
   * Update font size
   */
  public setFontSize(size: number): void {
    this.fontSize = size;
    this.metrics = this.measureFont();
    this.canvasStale = true;
  }

  /**
   * Update font family
   */
  public setFontFamily(family: string): void {
    this.fontFamily = family;
    this.metrics = this.measureFont();
    this.canvasStale = true;
  }

  /**
   * Update cursor style
   */
  public setCursorStyle(style: 'block' | 'underline' | 'bar'): void {
    if (style !== this.cursorStyle) this.cursorShapeChanged = true;
    this.cursorStyle = style;
  }

  /**
   * Enable/disable cursor blinking
   */
  public setCursorBlink(enabled: boolean): void {
    if (enabled !== this.cursorBlink) this.cursorShapeChanged = true;
    if (enabled && !this.cursorBlink) {
      this.cursorBlink = true;
      this.startCursorBlink();
    } else if (!enabled && this.cursorBlink) {
      this.cursorBlink = false;
      this.stopCursorBlink();
    }
  }

  /**
   * Get current font metrics
   */

  /**
   * Render scrollbar (Phase 2)
   * Shows scroll position and allows click/drag interaction
   * @param opacity Opacity level (0-1) for fade in/out effect
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1
  ): void {
    const ctx = this.ctx;
    const canvasHeight = this.canvas.height / this.devicePixelRatio;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(scrollbarX - 2, 0, scrollbarWidth + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Position: 0 = at bottom, scrollbackLength = at top
    const scrollPosition = viewportY / scrollbackLength; // 0 to 1
    const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(scrollbarX, scrollbarPadding, scrollbarWidth, scrollbarTrackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(scrollbarX, thumbY, scrollbarWidth, thumbHeight);
  }
  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * Check if a cell at (x, y) is within the current selection.
   * Uses cached selection coordinates for performance.
   */
  private isInSelection(x: number, y: number): boolean {
    const sel = this.currentSelectionCoords;
    if (!sel) return false;

    const { startCol, startRow, endCol, endRow } = sel;

    // Single line selection
    if (startRow === endRow) {
      return y === startRow && x >= startCol && x <= endCol;
    }

    // Multi-line selection
    if (y === startRow) {
      // First line: from startCol to end of line
      return x >= startCol;
    } else if (y === endRow) {
      // Last line: from start of line to endCol
      return x <= endCol;
    } else if (y > startRow && y < endRow) {
      // Middle lines: entire line is selected
      return true;
    }

    return false;
  }

  /**
   * Set the currently hovered hyperlink ID for rendering underlines
   */
  public setHoveredHyperlinkId(hyperlinkId: number): void {
    this.hoveredHyperlinkId = hyperlinkId;
  }

  /**
   * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    } | null
  ): void {
    this.hoveredLinkRange = range;
  }

  /**
   * Get character cell width (for coordinate conversion)
   */
  public get charWidth(): number {
    return this.metrics.width;
  }

  /**
   * Get character cell height (for coordinate conversion)
   */
  public get charHeight(): number {
    return this.metrics.height;
  }

  /**
   * Clear entire canvas
   */
  public clear(): void {
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvasStale = true;
  }

  /**
   * Cleanup resources
   */
  public dispose(): void {
    this.stopCursorBlink();
    this.stopWatchingDevicePixelRatio?.();
    this.canvas.removeEventListener('contextrestored', this.onContextRestored);
    // Free the scratch canvas' backing store
    this.scratch.width = 0;
    this.scratch.height = 0;
  }
}
