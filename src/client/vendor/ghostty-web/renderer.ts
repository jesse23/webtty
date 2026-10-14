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
import { type CellRange, cellInRange, moveRangeRows, sameRange } from './render/cell-range';
import { DEFAULT_THEME } from './render/default-theme';
import { watchDevicePixelRatio, wholeDevicePixelRatio } from './render/device-pixel-ratio';
import { type FontMetrics, measureFont } from './render/font-metrics';
import { frameLines } from './render/frame-lines';
import type {
  GraphemeLookup,
  IRenderable,
  IScrollbackProvider,
  RowContent,
} from './render/renderable';
import {
  changeRow,
  DEFAULT_OVERSCAN,
  invalidateOutOfView,
  invalidateRow,
  nextBand,
  ROW_CUT,
  ROW_INVALID,
  ROW_JOINED,
  repaintRunEnd,
  shiftedRowKeys,
  shiftedRowStates,
  wantedRowState,
} from './render/row-band';
import {
  SCROLLBAR_PADDING,
  SCROLLBAR_WIDTH,
  scrollbarThumbHeight,
  scrollbarThumbY,
  scrollbarTrackHeight,
  scrollbarX,
} from './render/scrollbar-geometry';
import {
  type HighlightSpan,
  highlightAt,
  highlightRows,
  type SearchHighlights,
  spansKey,
} from './search';
import type { SelectionManager } from './selection-manager';
import type { GhosttyCell } from './types';
import { CellFlags } from './types';

// The facade's former contents, re-exported so deep imports keep working (ADR 061)
export { DEFAULT_THEME } from './render/default-theme';
export { watchDevicePixelRatio, wholeDevicePixelRatio } from './render/device-pixel-ratio';
export type { FontMetrics } from './render/font-metrics';
export { frameLines } from './render/frame-lines';
export type { GraphemeLookup, IRenderable, IScrollbackProvider } from './render/renderable';
export { DEFAULT_OVERSCAN } from './render/row-band';

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
  overscan?: number; // Rows drawn above and below the viewport. Default: DEFAULT_OVERSCAN (webtty, ADR 043)
}

/**
 * Rows a partial repaint draws on the scratch canvas at once, besides the row below: a
 * longer run is repainted in chunks of this many rows, so the scratch canvas stays a few
 * rows high instead of growing to the canvas' size. (webtty, ADR 043)
 */
export const REPAINT_CHUNK_ROWS = 8;

// ============================================================================
// CanvasRenderer Class
// ============================================================================

export class CanvasRenderer {
  // The terminal's canvas element: it takes the viewport's place in the layout and gets
  // the mouse events, and draws nothing (webtty, ADR 043)
  private element: HTMLCanvasElement;
  // The canvas the rows are drawn on. It also holds the overscan rows, sits over the
  // element, moved up by a transform, and is clipped to the element's box (webtty, ADR 043)
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

  // Cursor blinking state
  private cursorVisible: boolean = true;
  private cursorBlinkInterval?: number;
  // Where the last frame drew the cursor: its canvas row (null: not drawn) and column (webtty)
  private cursorRow: number | null = null;
  private cursorCol: number = 0;
  // Cursor style or blink changed since the last frame: repaint the cursor cell so
  // the old shape does not stay under the new one (webtty)
  private cursorShapeChanged: boolean = false;

  // Viewport tracking (for scrolling)
  private lastViewportY: number = 0;
  private lastScrollbackLength: number = 0;

  // The canvas holds `overscan` rows above and below the viewport and is moved and
  // clipped to show the viewport's part of it. Canvas row k shows viewport row k - overscan at
  // viewportY `bandY`, so a scroll within the band only moves the canvas
  // (webtty, ADR 043).
  private readonly overscan: number;
  private bandY: number = 0;
  // ROW_INVALID, ROW_JOINED or ROW_CUT per canvas row. Rows out of view stay invalid
  // until they come into view.
  private rowState: Uint8Array = new Uint8Array(0);
  // The pixel offset below its whole line the viewport shows at, in CSS pixels (ADR 040)
  private requestedScrollOffset: number = 0;
  private shownScrollOffset: number = 0;
  // CSS pixels from the canvas top to the top of what is shown
  private shownTop: number = 0;
  private shownRows: number = 0;
  private shownTransform: string = '';
  private shownClip: string = '';
  // The first canvas row the last frame painted the scrollbar over (null: none)
  private scrollbarRow: number | null = null;

  // The canvas no longer matches its rows (theme, font or ratio change); the next frame
  // repaints every row (webtty, ADR 043)
  private canvasStale: boolean = false;
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
  // Cached selection coordinates for current render pass, in canvas rows and not
  // clamped to the viewport (webtty, ADR 043)
  private currentSelectionCoords: CellRange | null = null;
  // The selection the canvas rows were drawn with, in canvas rows (webtty, ADR 043)
  private drawnSelection: CellRange | null = null;

  // The hovered link's range (OSC 8 or regex), in viewport rows. The engine's
  // hyperlink_id is a 1-bit "has a link" flag, not an id, so the range is the only
  // thing that tells one link from another. (webtty)
  private hoveredLinkRange: CellRange | null = null;
  // The regex link range this frame draws and the one the canvas rows were drawn with,
  // in canvas rows (webtty, ADR 043)
  private currentLinkRange: CellRange | null = null;
  private drawnLinkRange: CellRange | null = null;

  // Search matches (webtty, ADR 055): the matches, the spans this frame draws per canvas
  // row, and the spans each canvas row was drawn with (as `spansKey`)
  private searchHighlights: SearchHighlights | null = null;
  private searchSpans: (HighlightSpan[] | undefined)[] = [];
  private drawnSearch: string[] = [];

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.element = canvas;
    // Positioned with no offsets, the drawing canvas sits where the element's box starts
    // (its static position), wherever padding moves it. Positioned, it paints over the
    // element, and lets the mouse through to it. (webtty, ADR 043)
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.pointerEvents = 'none';
    this.canvas.style.display = 'block';
    // Excluded from the lookups of the terminal canvas, like the edge strips
    this.canvas.dataset.edge = 'true';
    canvas.parentNode?.insertBefore(this.canvas, canvas);
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;
    // Frames only draw what changed, so a canvas the browser blanked would stay blank
    // (webtty, ADR 043)
    this.canvas.addEventListener('contextrestored', this.onContextRestored);
    this.scratch = document.createElement('canvas');
    this.scratch.width = 0;
    this.scratch.height = 0;

    // Apply options
    this.fontSize = options.fontSize ?? 15;
    this.fontFamily = options.fontFamily ?? 'monospace';
    this.cursorStyle = options.cursorStyle ?? 'block';
    this.cursorBlink = options.cursorBlink ?? false;
    this.overscan = Math.max(1, Math.floor(options.overscan ?? DEFAULT_OVERSCAN));
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
    const ctx = document.createElement('canvas').getContext('2d')!;
    return measureFont(ctx, this.fontSize, this.fontFamily);
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
    this.drawCount++;
    const cssWidth = cols * this.metrics.width;
    const cssHeight = rows * this.metrics.height;

    // Set CSS size (what user sees). The element draws nothing. (webtty, ADR 043)
    this.element.style.width = `${cssWidth}px`;
    this.element.style.height = `${cssHeight}px`;
    this.element.width = 0;
    this.element.height = 0;

    // Set actual canvas size (scaled for DPI). The canvas also holds the overscan rows;
    // render() moves and clips it to show the viewport's rows. (webtty, ADR 043)
    const canvasHeight = (rows + 2 * this.overscan) * this.metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${canvasHeight}px`;
    this.canvas.width = Math.round(cssWidth * this.devicePixelRatio);
    this.canvas.height = Math.round(canvasHeight * this.devicePixelRatio);

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(this.devicePixelRatio, this.devicePixelRatio);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, canvasHeight);
    // Free the scratch canvas' backing store; the next partial repaint sizes it
    this.scratch.width = 0;
    this.scratch.height = 0;
    this.canvasStale = true;
  }

  // ==========================================================================
  // Main Rendering
  // ==========================================================================

  /**
   * Render the terminal buffer to canvas
   *
   * The canvas holds `overscan` rows above and below the viewport, and is moved and
   * clipped to show the viewport's part of it. A scroll within those rows only moves the
   * canvas; one past them moves the canvas content with one
   * drawImage of the canvas onto itself. Only rows that come into view or changed are
   * drawn, and rows out of view are drawn when they come into view. What the element
   * shows is exactly a full redraw of the viewport, plus at a fraction of a line the row
   * above it drawn on its own. (webtty, ADR 043; see repaintRows)
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    // Record the view's offset before any read (webtty, ADR 042)
    buffer.setViewportOffset?.(viewportY);

    // Store buffer reference for grapheme lookups in renderCell
    this.currentBuffer = buffer;

    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    // The engine's shape and blink; a change repaints the cursor row (webtty, ADR 049)
    if (cursor.style !== undefined) this.setCursorStyle(cursor.style);
    if (cursor.blinking !== undefined) this.setCursorBlink(cursor.blinking);
    const dims = buffer.getDimensions();
    const getLine = frameLines(buffer, dims.cols, dims.rows);
    this.currentLine = getLine;
    const scrollbackLength = scrollbackProvider ? scrollbackProvider.getScrollbackLength() : 0;
    const rows = dims.rows;
    const total = rows + 2 * this.overscan;
    const view = Math.max(0, Math.floor(viewportY));

    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) {
      forceAll = true;
    }

    // Resize canvas if dimensions changed
    const needsResize =
      this.contextRestored ||
      this.canvas.width !== Math.round(dims.cols * this.metrics.width * this.devicePixelRatio) ||
      this.canvas.height !== Math.round(total * this.metrics.height * this.devicePixelRatio);

    if (needsResize) {
      this.resize(dims.cols, dims.rows);
      this.contextRestored = false;
      forceAll = true; // Force full render after resize
    }
    if (this.rowState.length !== total) {
      this.rowState = new Uint8Array(total);
      forceAll = true;
    }

    // A theme, font or ratio change since the last frame changes every row (webtty, ADR 043)
    if (this.canvasStale) {
      forceAll = true;
      this.canvasStale = false;
    }

    // Rows the engine changed, in screen rows
    const dirtyRows: number[] = [];
    if (!forceAll) {
      for (let y = 0; y < rows; y++) {
        if (buffer.isRowDirty(y)) dirtyRows.push(y);
      }
    }

    // A fractional viewportY (ghostty-web's own eased scroll) repaints every row
    const moved = viewportY !== this.lastViewportY;
    if (moved && !(Number.isInteger(viewportY) && Number.isInteger(this.lastViewportY))) {
      forceAll = true;
    }
    this.lastViewportY = viewportY;
    // New scrollback or a changed row may have moved every line: the screen scrolled.
    // While scrolled, or on a move, that repaints every row. At the bottom, the screen's
    // rows are repainted as dirty and the rows out of view when they come into view.
    const linesMoved = scrollbackLength !== this.lastScrollbackLength || dirtyRows.length > 0;
    if (linesMoved && (view > 0 || moved)) forceAll = true;
    this.lastScrollbackLength = scrollbackLength;

    // The row above the viewport shows while it is at a fraction of a line (ADR 040)
    // An offset set for a taller cell (before a font change) shows at most a line.
    const maxOffset = this.metrics.height - 1 / this.devicePixelRatio;
    const offset = view < scrollbackLength ? Math.min(this.requestedScrollOffset, maxOffset) : 0;
    const above = offset > 0 ? 1 : 0;

    // Keep the canvas rows while the rows in view are among them, else move the band and
    // copy the rows still in view (see nextBand)
    let band = this.bandY;
    if (forceAll) {
      band = view;
    } else {
      band = nextBand(this.bandY, view, this.overscan, above, scrollbackLength);
      const shift = band - this.bandY;
      if (Math.abs(shift) >= total) {
        forceAll = true;
      } else if (shift !== 0) {
        this.shiftRows(shift);
        this.rowState = shiftedRowStates(this.rowState, shift);
        if (this.cursorRow !== null) this.cursorRow += shift;
        if (this.scrollbarRow !== null) this.scrollbarRow += shift;
        this.drawnSelection = moveRangeRows(this.drawnSelection, shift);
        this.drawnLinkRange = moveRangeRows(this.drawnLinkRange, shift);
        this.drawnSearch = shiftedRowKeys(this.drawnSearch, shift, total);
      }
    }
    this.bandY = band;
    // The canvas row of viewport row 0
    const top = this.overscan + band - view;

    const state = this.rowState;
    if (forceAll) state.fill(ROW_INVALID);
    if (!forceAll) {
      for (const y of dirtyRows) changeRow(state, top + y);
      if (linesMoved) invalidateOutOfView(state, top, rows);
    }

    // The selection, in canvas rows. It is anchored to buffer lines like the canvas rows,
    // so it only repaints rows when it changed. (webtty, ADR 043)
    const selection =
      this.selectionManager && this.selectionManager.hasSelection()
        ? this.selectionManager.getSelectionRange()
        : null;
    this.currentSelectionCoords = moveRangeRows(selection, top);
    if (!sameRange(this.currentSelectionCoords, this.drawnSelection)) {
      for (const range of [this.drawnSelection, this.currentSelectionCoords]) {
        if (!range) continue;
        const last = Math.min(range.endRow, total - 1);
        for (let k = Math.max(0, range.startRow); k <= last; k++) changeRow(state, k);
      }
    }
    this.drawnSelection = this.currentSelectionCoords;

    // Search matches, in canvas rows; a row whose matches changed is repainted
    // (webtty, ADR 055)
    if (this.drawnSearch.length !== total) this.drawnSearch = new Array<string>(total).fill('');
    this.searchSpans = new Array(total);
    if (this.searchHighlights) {
      // Canvas row k shows screen row k - top plus the screen row at the viewport's top
      const toScreen = scrollbackLength - view - top;
      const spans = highlightRows(this.searchHighlights, toScreen, toScreen + total - 1, dims.cols);
      for (const [row, s] of spans) this.searchSpans[row - toScreen] = s;
    }
    for (let k = 0; k < total; k++) {
      if (spansKey(this.searchSpans[k]) !== this.drawnSearch[k]) changeRow(state, k);
    }

    const rowAt = (k: number) =>
      this.rowAt(k - this.overscan, band, rows, getLine, buffer, scrollbackProvider, scrollbackLength);

    // A link underline is drawn at viewport rows, which are other canvas rows after a
    // scroll: clear it where it was drawn and draw it where it is.
    this.currentLinkRange = moveRangeRows(this.hoveredLinkRange, top);
    if (!sameRange(this.currentLinkRange, this.drawnLinkRange)) {
      for (const range of [this.drawnLinkRange, this.currentLinkRange]) {
        if (!range) continue;
        for (let k = range.startRow; k <= range.endRow; k++) changeRow(state, k);
      }
    }
    this.drawnLinkRange = this.currentLinkRange;

    // The cursor is drawn over its cell after the rows. Repaint the cell the last frame's
    // cursor is in now unless the same cursor is drawn there again.
    const drawsCursor = view === 0 && cursor.visible && this.cursorVisible;
    const cursorRow = top + cursor.y;
    let sameCursor = false;
    if (this.cursorRow !== null) {
      sameCursor =
        drawsCursor &&
        this.cursorRow === cursorRow &&
        cursor.x === this.cursorCol &&
        !this.cursorShapeChanged;
      if (!sameCursor) invalidateRow(state, this.cursorRow);
    }
    this.cursorShapeChanged = false;

    // The scrollbar is painted over the right edge of the rows in view. Rows it no longer
    // covers are repainted, so none keeps the old thumb.
    const paintsScrollbar = !!scrollbackProvider && scrollbarOpacity > 0;
    const scrollbarRow = paintsScrollbar ? top : null;
    if (this.scrollbarRow !== null && this.scrollbarRow !== scrollbarRow) {
      for (let k = this.scrollbarRow; k < this.scrollbarRow + rows; k++) {
        if (scrollbarRow === null || k < scrollbarRow || k >= scrollbarRow + rows) {
          invalidateRow(state, k);
        }
      }
    }

    // Repaint the rows in view that are not as a full redraw of the viewport leaves them:
    // the last row and the row above the viewport have nothing drawn into them from below.
    const first = top - above;
    const last = top + rows - 1;
    const repainted = new Uint8Array(total);
    for (let k = first; k <= last; k++) {
      if (state[k] === wantedRowState(k, top, last)) continue;
      const end = repaintRunEnd(state, k, top, last);
      this.repaintRows(k, end, wantedRowState(end, top, last) === ROW_CUT, dims.cols, rowAt);
      repainted.fill(1, k, end + 1);
      k = end;
    }
    for (let k = 0; k < total; k++) {
      if (repainted[k]) this.drawnSearch[k] = spansKey(this.searchSpans[k]);
    }

    // Selection highlighting is now integrated into renderCellBackground/renderCellText
    // No separate overlay pass needed - this fixes z-order issues with complex glyphs

    // Link underlines are drawn during cell rendering (see renderCell)

    // Render cursor (only if we're at the bottom, not scrolled). The same cursor over a
    // row that was not repainted is still on the canvas: drawing it again would blend a
    // translucent cursor colour over itself until it is opaque.
    if (drawsCursor && !(sameCursor && !repainted[cursorRow])) {
      this.renderCursor(cursor.x, cursorRow, cursor.y);
    }
    this.cursorRow = drawsCursor ? cursorRow : null;
    this.cursorCol = cursor.x;

    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (paintsScrollbar) {
      this.renderScrollbar(viewportY, scrollbackLength, rows, scrollbarOpacity, top);
    }
    this.scrollbarRow = scrollbarRow;

    // Show the viewport's rows, moved down by the offset: move the canvas up by what is
    // above them and clip it to the element's box. A transform places it to the device
    // pixel; object-position would round to CSS pixels.
    this.shownScrollOffset = offset;
    this.shownTop = top * this.metrics.height - offset;
    this.shownRows = rows;
    const below = (total - rows) * this.metrics.height - this.shownTop;
    const transform = `translateY(${-this.shownTop}px)`;
    const clip = `inset(${this.shownTop}px 0px ${below}px 0px)`;
    if (transform !== this.shownTransform) {
      this.canvas.style.transform = transform;
      this.shownTransform = transform;
    }
    if (clip !== this.shownClip) {
      this.canvas.style.clipPath = clip;
      this.shownClip = clip;
    }

    // Without scrollback rows a scrolled frame left its top rows unpainted
    if (viewportY > 0 && !scrollbackProvider) this.canvasStale = true;

    // ALWAYS clear dirty flags after rendering, regardless of forceAll.
    // This is critical - if we don't clear after a full redraw, the dirty
    // state persists and the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * The line at viewport row `y` for `viewportY`, from scrollback or the screen, with a
   * grapheme lookup on the same source: canvas row y is not screen row y while scrolled.
   * Null above the scrollback and below the screen. (webtty)
   */
  private rowAt(
    y: number,
    viewportY: number,
    rows: number,
    getLine: (y: number) => GhosttyCell[] | null,
    buffer: IRenderable,
    scrollbackProvider: IScrollbackProvider | undefined,
    scrollbackLength: number
  ): RowContent {
    if (y < viewportY) {
      // This row is from scrollback, counted from its end
      const scrollbackOffset = scrollbackLength - viewportY + y;
      if (!scrollbackProvider || scrollbackOffset < 0) return { line: null };
      return {
        line: scrollbackProvider.getScrollbackLine(scrollbackOffset),
        grapheme: this.scrollbackGraphemes(scrollbackProvider, scrollbackOffset),
      };
    }
    // This row is from the screen
    const screenRow = y - viewportY;
    if (screenRow >= rows) return { line: null };
    return { line: getLine(screenRow), grapheme: this.screenGraphemes(buffer, screenRow) };
  }

  /**
   * Repaints canvas rows `first` to `last` exactly as a full redraw leaves them. A full
   * redraw draws every row in order, each clearing its own cell area first, so a row's
   * pixels are its own cells plus whatever the next line draws over it (tall glyphs,
   * combining marks); what the row above overflows into it is cleared. So the rows are
   * drawn in order, plus the next line unless the last row is `cut`: drawn with its own
   * cells only, as the last row of a full redraw is.
   *
   * The rows are drawn on the scratch canvas and copied into the canvas, unless they are
   * cut and the rows they draw into around them are invalid anyway. A run that is not cut
   * ends before a row that is kept. Drawing them clipped to the rows is
   * not the same: Chrome skips a glyph whose box is outside the clip, so a combining mark
   * of the next line loses the antialiased edge it draws on the last pixel line.
   * A long run is drawn on the scratch canvas in chunks of `REPAINT_CHUNK_ROWS` rows, each
   * with the next line, which leaves every row as the whole run drawn at once would: a
   * row's pixels depend only on its own line and the next.
   * (webtty, ADR 043)
   */
  private repaintRows(
    first: number,
    last: number,
    cut: boolean,
    cols: number,
    rowAt: (k: number) => RowContent
  ): void {
    this.drawCount++;
    const state = this.rowState;
    const total = state.length;
    const free = (k: number) => k < 0 || k >= total || state[k] === ROW_INVALID;
    // Drawn on the canvas, the row above gets the first row's overflow and the row below
    // the last one's
    if (cut && free(first - 1) && free(last + 1)) {
      for (let k = first; k <= last; k++) this.drawRow(k, cols, rowAt(k));
    } else {
      for (let from = first; from <= last; from += REPAINT_CHUNK_ROWS) {
        const to = Math.min(from + REPAINT_CHUNK_ROWS - 1, last);
        this.repaintChunk(from, to, cut && to === last, cols, rowAt);
      }
    }
    for (let k = first; k <= last; k++) state[k] = ROW_JOINED;
    state[last] = cut ? ROW_CUT : ROW_JOINED;
  }

  /**
   * Draws canvas rows `first` to `last`, plus the next line unless `cut`, on the scratch
   * canvas and copies rows `first` to `last` into the canvas. (webtty, ADR 043)
   */
  private repaintChunk(
    first: number,
    last: number,
    cut: boolean,
    cols: number,
    rowAt: (k: number) => RowContent
  ): void {
    const end = cut ? last : last + 1;
    const own = this.ctx;
    const rowHeight = this.metrics.height * this.devicePixelRatio;
    this.ctx = this.scratchContext(first, end - first + 1);
    try {
      for (let k = first; k <= end; k++) this.drawRow(k, cols, rowAt(k));
    } finally {
      this.ctx = own;
    }
    // Replace the rows' pixels in device pixels: cleared first, the copy is not blended
    // over them, so a translucent background does not darken
    const width = this.canvas.width;
    const top = first * rowHeight;
    const height = (last - first + 1) * rowHeight;
    own.save();
    own.setTransform(1, 0, 0, 1, 0, 0);
    own.globalAlpha = 1;
    own.globalCompositeOperation = 'source-over';
    own.imageSmoothingEnabled = false;
    own.clearRect(0, top, width, height);
    own.drawImage(this.scratch, 0, 0, width, height, 0, top, width, height);
    own.restore();
  }

  /** Draws canvas row `k`; a row with no line (past the buffer's ends) is left blank. */
  private drawRow(
    k: number,
    cols: number,
    { line, grapheme }: RowContent
  ): void {
    this.drawCount++;
    if (line) {
      this.renderLine(line, k, cols, grapheme);
      return;
    }
    const y = k * this.metrics.height;
    const width = cols * this.metrics.width;
    this.ctx.clearRect(0, y, width, this.metrics.height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.fillRect(0, y, width, this.metrics.height);
  }

  /**
   * The scratch canvas' context, as wide as the canvas and at least `count` rows high,
   * scaled like the canvas and moved up so canvas row `first` is drawn at its top.
   * (webtty, ADR 043)
   */
  private scratchContext(first: number, count: number): CanvasRenderingContext2D {
    const rowHeight = this.metrics.height * this.devicePixelRatio;
    const width = this.canvas.width;
    const height = count * rowHeight;
    if (this.scratch.width !== width) this.scratch.width = width;
    if (this.scratch.height < height) this.scratch.height = height;
    const ctx = this.scratch.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    // Set every time: resizing, or a lost context, resets the context state
    ctx.setTransform(this.devicePixelRatio, 0, 0, this.devicePixelRatio, 0, -first * rowHeight);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    return ctx;
  }

  /**
   * Moves the canvas content down by `rows` rows (up when negative) with one drawImage of
   * the canvas onto itself, in device pixels. The 'copy' operator replaces pixels instead
   * of blending onto them (a translucent background would darken) and clears the rest of
   * the canvas: the rows that came in, which are invalid. (webtty, ADR 043)
   */
  private shiftRows(rows: number): void {
    this.drawCount++;
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
    this.drawCount++;
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
    const isSelected = cellInRange(this.currentSelectionCoords, x, y);

    if (isSelected) {
      // Draw selection background (solid color, not overlay)
      this.ctx.fillStyle = this.theme.selectionBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return; // Selection background replaces cell background
    }

    // A search match replaces it too, under the selection as in Ghostty (webtty, ADR 055)
    const match = highlightAt(this.searchSpans[y], x);
    if (match) {
      this.ctx.fillStyle =
        match === 2 ? this.theme.searchSelectedBackground : this.theme.searchBackground;
      this.ctx.fillRect(cellX, cellY, cellWidth, this.metrics.height);
      return;
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
    const isSelected = cellInRange(this.currentSelectionCoords, x, y);

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
    } else if (highlightAt(this.searchSpans[y], x)) {
      this.ctx.fillStyle =
        highlightAt(this.searchSpans[y], x) === 2
          ? this.theme.searchSelectedForeground
          : this.theme.searchForeground;
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

    // Draw the hovered link's underline (OSC 8 or plain text URL), in canvas rows
    // (webtty, ADR 043)
    if (cellInRange(this.currentLinkRange, x, y)) {
      const underlineY = cellY + this.metrics.baseline + 2;
      this.ctx.strokeStyle = '#4A90E2'; // Blue underline on hover
      this.ctx.lineWidth = 1;
      this.ctx.beginPath();
      this.ctx.moveTo(cellX, underlineY);
      this.ctx.lineTo(cellX + cellWidth, underlineY);
      this.ctx.stroke();
    }
  }

  /**
   * Render cursor at canvas row `y`, which shows screen row `screenRow` (webtty)
   */
  private renderCursor(x: number, y: number, screenRow: number): void {
    this.drawCount++;
    const cursorX = x * this.metrics.width;
    const cursorY = y * this.metrics.height;

    this.ctx.fillStyle = this.theme.cursor;

    switch (this.cursorStyle) {
      case 'block':
        // Full cell block
        this.ctx.fillRect(cursorX, cursorY, this.metrics.width, this.metrics.height);
        // Re-draw character under cursor with cursorAccent color
        {
          const line = this.currentLine(screenRow);
          if (line?.[x]) {
            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.rect(cursorX, cursorY, this.metrics.width, this.metrics.height);
            this.ctx.clip();
            // The grapheme of the screen row, not of the canvas row (webtty, ADR 043)
            this.renderCellText(
              line[x],
              x,
              y,
              this.theme.cursorAccent,
              this.screenGraphemes(this.currentBuffer, screenRow)
            );
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
   * @param row The canvas row of viewport row 0: it is painted over the rows in view (webtty)
   */
  private renderScrollbar(
    viewportY: number,
    scrollbackLength: number,
    visibleRows: number,
    opacity: number = 1,
    row: number = 0
  ): void {
    this.drawCount++;
    const ctx = this.ctx;
    const top = row * this.metrics.height;
    const canvasHeight = visibleRows * this.metrics.height;
    const canvasWidth = this.canvas.width / this.devicePixelRatio;

    // Scrollbar dimensions (shared with the terminal's hit test)
    const x = scrollbarX(canvasWidth);
    const trackHeight = scrollbarTrackHeight(canvasHeight);

    // Always clear the scrollbar area first (fixes ghosting when fading out)
    ctx.clearRect(x - 2, top, SCROLLBAR_WIDTH + 6, canvasHeight);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(x - 2, top, SCROLLBAR_WIDTH + 6, canvasHeight);

    // Don't draw scrollbar if fully transparent or no scrollback
    if (opacity <= 0 || scrollbackLength === 0) return;

    // Calculate scrollbar thumb size and position (0 = at bottom, scrollbackLength = at top)
    const thumbHeight = scrollbarThumbHeight(visibleRows, scrollbackLength, trackHeight);
    const thumbY = scrollbarThumbY(viewportY, scrollbackLength, trackHeight, thumbHeight);

    // Draw scrollbar track (subtle background) with opacity
    ctx.fillStyle = `rgba(128, 128, 128, ${0.1 * opacity})`;
    ctx.fillRect(x, top + SCROLLBAR_PADDING, SCROLLBAR_WIDTH, trackHeight);

    // Draw scrollbar thumb with opacity
    const isScrolled = viewportY > 0;
    const baseOpacity = isScrolled ? 0.5 : 0.3;
    ctx.fillStyle = `rgba(128, 128, 128, ${baseOpacity * opacity})`;
    ctx.fillRect(x, top + thumbY, SCROLLBAR_WIDTH, thumbHeight);
  }

  public getMetrics(): FontMetrics {
    return { ...this.metrics };
  }

  /**
   * Get canvas element (needed by SelectionManager)
   */
  public getCanvas(): HTMLCanvasElement {
    return this.element;
  }

  /**
   * Sets the pixel offset below its whole line the viewport shows at, in CSS pixels
   * snapped to device pixels, for pixel-smooth scrolling. The next frame moves what the
   * element shows by it. (webtty, ADR 040, ADR 043)
   */
  public setScrollOffset(offset: number): void {
    this.requestedScrollOffset = offset;
  }

  /**
   * The offset the viewport is shown at, in CSS pixels: viewport row 0 starts
   * this far below the element's top. Hit testing adds it. (webtty, ADR 043)
   */
  /** Counts the calls that draw on the canvas: `visibleArea.version`. (webtty) */
  private drawCount = 0;

  public get scrollOffset(): number {
    return this.shownScrollOffset;
  }

  /**
   * The canvas the rows are drawn on and the part of it in view, in canvas pixels; the
   * rest is overscan. `lastLine` is the bottom pixel line of the viewport's last row,
   * which at a fraction of a line is below the part in view. `version` changes whenever
   * the canvas is drawn on, so a copy of its pixels can tell it is stale. (webtty, ADR 043)
   */
  public get visibleArea(): {
    canvas: HTMLCanvasElement;
    y: number;
    height: number;
    lastLine: number;
    version: number;
  } {
    const dpr = this.devicePixelRatio;
    const bottom = this.shownTop + this.shownScrollOffset + this.shownRows * this.metrics.height;
    return {
      canvas: this.canvas,
      y: Math.round(this.shownTop * dpr),
      height: this.shownRows * this.metrics.height * dpr,
      lastLine: Math.round(bottom * dpr) - 1,
      version: this.drawCount,
    };
  }

  /**
   * Set selection manager (for rendering selection)
   */
  public setSelectionManager(manager: SelectionManager): void {
    this.selectionManager = manager;
  }

  /**
   * The search matches to highlight, or null for none. Rows whose matches change are
   * repainted on the next frame. (webtty, ADR 055)
   */
  public setSearchHighlights(highlights: SearchHighlights | null): void {
    this.searchHighlights = highlights;
  }

  /**
   * Set the currently hovered link range for rendering underlines (OSC 8 or regex links)
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
    this.hoveredLinkRange = range && {
      startCol: range.startX,
      startRow: range.startY,
      endCol: range.endX,
      endRow: range.endY,
    };
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
    this.drawCount++;
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
    this.canvas.remove?.();
    // Free the scratch canvas' backing store
    this.scratch.width = 0;
    this.scratch.height = 0;
  }
}
