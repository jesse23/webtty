// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The canvas renderer (facade): `CanvasRenderer` plans each frame, which canvas rows of the
// overscan band to keep, copy or repaint, and hands the drawing to the painters in render/
// on the context it chooses (ADR 040, ADR 043, ADR 061).

import { DisposableStore, listen, toDisposable } from './lifecycle/disposable-store';
import { CellPainter } from './render/cell-painter';
import { DecorationTracker, type SelectionSource } from './render/decoration-tracker';
import { CursorBlink, CursorPainter } from './render/cursor-painter';
import { DEFAULT_THEME } from './render/default-theme';
import { watchDevicePixelRatio, wholeDevicePixelRatio } from './render/device-pixel-ratio';
import { type FontMetrics, measureFont } from './render/font-metrics';
import { frameLines, type RowSource, rowContent } from './render/frame-lines';
import type {
  CursorStyle,
  DrawCounter,
  IRenderable,
  IScrollbackProvider,
  PaintSettings,
  RendererDeps,
  RendererOptions,
} from './render/renderable';
import {
  changeRow,
  DEFAULT_OVERSCAN,
  invalidateOutOfView,
  nextBand,
  ROW_INVALID,
  shiftedRowStates,
} from './render/row-band';
import { RowRepainter } from './render/row-repainter';
import { type FrameMoves, ScrollTracker } from './render/scroll-tracker';
import { ScrollbarPainter } from './render/scrollbar-painter';
import { createDrawingCanvas, ViewportClip, type VisibleArea } from './render/viewport-clip';
import type { SearchHighlights } from './search';

// The facade's former contents, re-exported so deep imports keep working (ADR 061)
export { DEFAULT_THEME } from './render/default-theme';
export { watchDevicePixelRatio, wholeDevicePixelRatio } from './render/device-pixel-ratio';
export type { FontMetrics } from './render/font-metrics';
export { frameLines } from './render/frame-lines';
export type {
  GraphemeLookup,
  IRenderable,
  IScrollbackProvider,
  RendererDeps,
  RendererOptions,
} from './render/renderable';
export { DEFAULT_OVERSCAN } from './render/row-band';
export { REPAINT_CHUNK_ROWS } from './render/row-repainter';

/**
 * Draws the terminal on a canvas of its own that holds `overscan` rows above and below the
 * viewport, moved and clipped to show the viewport's part of it (webtty, ADR 043).
 */
export class CanvasRenderer {
  // The terminal's canvas element: it takes the viewport's place in the layout and gets
  // the mouse events, and draws nothing (webtty, ADR 043)
  private readonly element: HTMLCanvasElement;
  // The canvas the rows are drawn on. It also holds the overscan rows, sits over the
  // element, moved up by a transform, and is clipped to the element's box (webtty, ADR 043)
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly document: Pick<Document, 'createElement'>;
  private readonly settings: PaintSettings;
  private readonly counter: DrawCounter = { draws: 0 };
  private readonly decorations = new DecorationTracker();
  private readonly cells: CellPainter;
  private readonly repainter: RowRepainter;
  private readonly cursor: CursorPainter;
  private readonly blink: CursorBlink;
  private readonly scrollbar: ScrollbarPainter;
  private readonly disposables = new DisposableStore();

  private readonly moves = new ScrollTracker();

  // Canvas row k shows viewport row k - overscan at viewportY `bandY`, so a scroll within
  // the band only moves the canvas (webtty, ADR 043).
  private readonly overscan: number;
  private bandY = 0;
  // ROW_INVALID, ROW_JOINED or ROW_CUT per canvas row. Rows out of view stay invalid
  // until they come into view.
  private rowState: Uint8Array = new Uint8Array(0);
  // The pixel offset below its whole line the viewport shows at, in CSS pixels (ADR 040)
  private requestedScrollOffset = 0;
  private readonly clip: ViewportClip;

  // The canvas no longer matches its rows (theme, font or ratio change); the next frame
  // repaints every row (webtty, ADR 043)
  private canvasStale = false;
  // The browser restored a lost context: the backing store is blank and the context
  // state reset, so the next frame resizes and repaints every row (webtty, ADR 043)
  private contextRestored = false;

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}, deps: RendererDeps = {}) {
    this.element = canvas;
    this.document = deps.document ?? document;
    this.canvas = createDrawingCanvas(this.document, canvas);
    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;
    // Frames only draw what changed, so a canvas the browser blanked would stay blank
    // (webtty, ADR 043)
    this.disposables.add(
      listen(this.canvas, 'contextrestored', () => {
        this.contextRestored = true;
      })
    );
    const scratch = this.document.createElement('canvas');

    this.overscan = Math.max(1, Math.floor(options.overscan ?? DEFAULT_OVERSCAN));
    const win = () => deps.window ?? window;
    this.settings = {
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      theme: { ...DEFAULT_THEME, ...options.theme },
      devicePixelRatio: wholeDevicePixelRatio(options.devicePixelRatio ?? win().devicePixelRatio),
      metrics: { width: 0, height: 0, baseline: 0 },
    };
    // Follow ratio changes; the next render() sees the backing-store mismatch and
    // resizes and repaints the canvas.
    if (options.devicePixelRatio === undefined) {
      const stop = watchDevicePixelRatio(win(), (ratio) => {
        this.settings.devicePixelRatio = wholeDevicePixelRatio(ratio);
        this.canvasStale = true;
      });
      this.disposables.add(toDisposable(stop));
    }
    this.settings.metrics = this.measureFont();

    this.cells = new CellPainter(this.settings, this.decorations.frame, this.counter);
    const { settings, counter } = this;
    this.repainter = new RowRepainter(this.canvas, ctx, scratch, this.cells, settings, counter);
    this.cursor = new CursorPainter(options.cursorStyle ?? 'block', this.cells, settings, counter);
    this.scrollbar = new ScrollbarPainter(this.canvas, this.settings, this.counter);
    this.clip = new ViewportClip(this.canvas);
    this.blink = this.disposables.add(new CursorBlink(deps.timers));
    this.blink.setEnabled(options.cursorBlink ?? false);
  }

  /** The whole ratio the canvas backing store is drawn at. */
  public get devicePixelRatio(): number {
    return this.settings.devicePixelRatio;
  }

  private measureFont(): FontMetrics {
    // Use an offscreen canvas for measurement
    const ctx = this.document.createElement('canvas').getContext('2d')!;
    return measureFont(ctx, this.settings.fontSize, this.settings.fontFamily);
  }

  /** Remeasures the font (after it loads or changes); the next frame repaints every row. */
  public remeasureFont(): void {
    this.settings.metrics = this.measureFont();
    this.canvasStale = true;
  }

  /** Sizes the element and the drawing canvas (with its overscan rows) for `cols` × `rows`. */
  public resize(cols: number, rows: number): void {
    this.counter.draws++;
    const { metrics, devicePixelRatio: dpr } = this.settings;
    const cssWidth = cols * metrics.width;
    const cssHeight = rows * metrics.height;

    // Set CSS size (what user sees). The element draws nothing. (webtty, ADR 043)
    this.element.style.width = `${cssWidth}px`;
    this.element.style.height = `${cssHeight}px`;
    this.element.width = 0;
    this.element.height = 0;

    // Set actual canvas size (scaled for DPI). The canvas also holds the overscan rows;
    // render() moves and clips it to show the viewport's rows. (webtty, ADR 043)
    const canvasHeight = (rows + 2 * this.overscan) * metrics.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${canvasHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(canvasHeight * dpr);

    // Scale context to match DPI (setting canvas.width/height resets the context)
    this.ctx.scale(dpr, dpr);

    // Set text rendering properties for crisp text
    this.ctx.textBaseline = 'alphabetic';
    this.ctx.textAlign = 'left';

    // Fill background after resize
    this.ctx.fillStyle = this.settings.theme.background;
    this.ctx.fillRect(0, 0, cssWidth, canvasHeight);
    this.repainter.freeScratch();
    this.canvasStale = true;
  }

  /**
   * Render the terminal buffer to canvas
   *
   * A scroll within the overscan rows only moves the canvas; one past them moves the
   * canvas content with one drawImage of the canvas onto itself. Only rows that come into
   * view or changed are drawn, and rows out of view are drawn when they come into view.
   * What the element shows is exactly a full redraw of the viewport, plus at a fraction of
   * a line the row above it drawn on its own. (webtty, ADR 043; see RowRepainter)
   */
  public render(
    buffer: IRenderable,
    forceAll: boolean = false,
    viewportY: number = 0,
    scrollbackProvider?: IScrollbackProvider,
    scrollbarOpacity: number = 1
  ): void {
    const { cursor, cols, source } = this.readFrame(buffer, viewportY, scrollbackProvider);
    const rows = source.rows;
    const total = rows + 2 * this.overscan;
    const view = Math.max(0, Math.floor(viewportY));
    forceAll = this.prepareCanvas(buffer, cols, rows, total, forceAll);
    const moves = this.moves.track(source, viewportY, view, forceAll);
    forceAll = moves.repaintAll;

    // The row above the viewport shows while it is at a fraction of a line (ADR 040)
    const offset = view < source.scrollbackLength ? this.clampedScrollOffset() : 0;
    const above = offset > 0 ? 1 : 0;

    forceAll = this.moveBand(view, above, source.scrollbackLength, total, forceAll);
    // The canvas row of viewport row 0
    const top = this.overscan + this.bandY - view;
    const state = this.rowState;
    if (forceAll) state.fill(ROW_INVALID);
    else this.invalidateMoved(moves, top, rows);
    this.decorations.mark(state, top, view, cols, source.scrollbackLength);

    // The cursor is drawn over its cell after the rows. Repaint the cell the last frame's
    // cursor is in now unless the same cursor is drawn there again.
    const drawsCursor = view === 0 && cursor.visible && this.blink.visible;
    const cursorRow = top + cursor.y;
    const sameCursor = this.cursor.invalidateDrawn(state, drawsCursor, cursorRow, cursor.x);
    // The scrollbar is painted over the right edge of the rows in view. Rows it no longer
    // covers are repainted, so none keeps the old thumb.
    const paintsScrollbar = !!scrollbackProvider && scrollbarOpacity > 0;
    this.scrollbar.moveTo(state, paintsScrollbar ? top : null, rows);

    const band = this.bandY;
    const rowAt = (k: number) => rowContent(source, k - this.overscan, band);
    const last = top + rows - 1;
    const repainted = this.repainter.repaintView(state, top - above, top, last, cols, rowAt);
    this.decorations.repainted(repainted);

    // Render cursor (only if we're at the bottom, not scrolled). The same cursor over a
    // row that was not repainted is still on the canvas: drawing it again would blend a
    // translucent cursor colour over itself until it is opaque.
    if (drawsCursor && !(sameCursor && !repainted[cursorRow])) {
      this.cursor.paint(this.ctx, cursor.x, cursorRow, cursor.y, source);
    }
    this.cursor.drawnAt(drawsCursor ? cursorRow : null, cursor.x);
    // Render scrollbar if scrolled or scrollback exists (with opacity for fade effect)
    if (paintsScrollbar) {
      const { scrollbackLength } = source;
      this.scrollbar.paint(this.ctx, viewportY, scrollbackLength, rows, scrollbarOpacity, top);
    }
    this.clip.show(top, offset, rows, total, this.settings.metrics.height);

    // Without scrollback rows a scrolled frame left its top rows unpainted
    if (viewportY > 0 && !scrollbackProvider) this.canvasStale = true;
    // ALWAYS clear dirty flags after rendering, regardless of forceAll: if they persisted
    // after a full redraw, the next frame might not detect new changes properly.
    buffer.clearDirty();
  }

  /**
   * Reads what a frame starts from: records the view's offset before any read
   * (webtty, ADR 042), then the cursor, whose engine shape and blink are drawn (a change
   * repaints the cursor row; webtty, ADR 049), the size, and where the rows come from.
   */
  private readFrame(
    buffer: IRenderable,
    viewportY: number,
    scrollback: IScrollbackProvider | undefined
  ) {
    buffer.setViewportOffset?.(viewportY);
    // getCursor() calls update() internally to ensure fresh state.
    // Multiple update() calls are safe - dirty state persists until clearDirty().
    const cursor = buffer.getCursor();
    if (cursor.style !== undefined) this.setCursorStyle(cursor.style);
    if (cursor.blinking !== undefined) this.setCursorBlink(cursor.blinking);
    const { cols, rows } = buffer.getDimensions();
    const source: RowSource = {
      buffer,
      getLine: frameLines(buffer, cols, rows),
      rows,
      scrollback,
      scrollbackLength: scrollback ? scrollback.getScrollbackLength() : 0,
    };
    return { cursor, cols, source };
  }

  /** The requested offset, at most a line: one set for a taller cell (before a font change). */
  private clampedScrollOffset(): number {
    const maxOffset = this.settings.metrics.height - 1 / this.devicePixelRatio;
    return Math.min(this.requestedScrollOffset, maxOffset);
  }

  /** Invalidates the rows the engine changed and, when the lines moved, the rows out of view. */
  private invalidateMoved(moves: FrameMoves, top: number, rows: number): void {
    for (const y of moves.dirtyRows) changeRow(this.rowState, top + y);
    if (moves.linesMoved) invalidateOutOfView(this.rowState, top, rows);
  }

  /**
   * Resizes the canvas when its size, ratio or context no longer match, and sizes the row
   * states; returns whether every row must be repainted.
   */
  private prepareCanvas(
    buffer: IRenderable,
    cols: number,
    rows: number,
    total: number,
    forceAll: boolean
  ): boolean {
    // Check if buffer needs full redraw (e.g., screen change between normal/alternate)
    if (buffer.needsFullRedraw?.()) forceAll = true;
    const { metrics, devicePixelRatio: dpr } = this.settings;
    const needsResize =
      this.contextRestored ||
      this.canvas.width !== Math.round(cols * metrics.width * dpr) ||
      this.canvas.height !== Math.round(total * metrics.height * dpr);
    if (needsResize) {
      this.resize(cols, rows);
      this.contextRestored = false;
      forceAll = true;
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
    return forceAll;
  }

  /**
   * Keeps the canvas rows while the rows in view are among them, else moves the band and
   * copies the rows still in view (see nextBand); returns whether every row must be
   * repainted.
   */
  private moveBand(
    view: number,
    above: number,
    scrollbackLength: number,
    total: number,
    forceAll: boolean
  ): boolean {
    if (forceAll) {
      this.bandY = view;
      return true;
    }
    const band = nextBand(this.bandY, view, this.overscan, above, scrollbackLength);
    const shift = band - this.bandY;
    this.bandY = band;
    if (Math.abs(shift) >= total) return true;
    if (shift !== 0) {
      this.repainter.shiftRows(shift);
      this.rowState = shiftedRowStates(this.rowState, shift);
      this.cursor.shift(shift);
      this.scrollbar.shift(shift);
      this.decorations.shift(shift, total);
    }
    return false;
  }

  /** Sets the font size; the next frame repaints every row. */
  public setFontSize(size: number): void {
    this.settings.fontSize = size;
    this.remeasureFont();
  }

  /** Sets the font family; the next frame repaints every row. */
  public setFontFamily(family: string): void {
    this.settings.fontFamily = family;
    this.remeasureFont();
  }

  /** Sets the cursor shape; a change repaints the cursor cell on the next frame. */
  public setCursorStyle(style: CursorStyle): void {
    this.cursor.setStyle(style);
  }

  /** Turns the cursor blink on or off; a change repaints the cursor cell on the next frame. */
  public setCursorBlink(enabled: boolean): void {
    if (enabled !== this.blink.enabled) this.cursor.markShapeChanged();
    this.blink.setEnabled(enabled);
  }

  /** The cell size and baseline, a copy. */
  public getMetrics(): FontMetrics {
    return { ...this.settings.metrics };
  }

  /** The terminal's canvas element (needed by SelectionManager). */
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
  public get scrollOffset(): number {
    return this.clip.offset;
  }

  /**
   * The canvas the rows are drawn on and the part of it in view, in canvas pixels; the
   * rest is overscan. `lastLine` is the bottom pixel line of the viewport's last row,
   * which at a fraction of a line is below the part in view. `version` changes whenever
   * the canvas is drawn on, so a copy of its pixels can tell it is stale. (webtty, ADR 043)
   */
  public get visibleArea(): VisibleArea {
    return this.clip.area(this.devicePixelRatio, this.settings.metrics.height, this.counter.draws);
  }

  /** Sets the selection to draw; rows whose selection changed are repainted next frame. */
  public setSelectionManager(manager: SelectionSource): void {
    this.decorations.setSelectionSource(manager);
  }

  /**
   * The search matches to highlight, or null for none. Rows whose matches change are
   * repainted on the next frame. (webtty, ADR 055)
   */
  public setSearchHighlights(highlights: SearchHighlights | null): void {
    this.decorations.setSearchHighlights(highlights);
  }

  /**
   * Set the currently hovered link range for rendering underlines (OSC 8 or regex links)
   * Pass null to clear the hover state
   */
  public setHoveredLinkRange(
    range: { startX: number; startY: number; endX: number; endY: number } | null
  ): void {
    this.decorations.setHoveredLink(
      range && {
        startCol: range.startX,
        startRow: range.startY,
        endCol: range.endX,
        endRow: range.endY,
      }
    );
  }

  /** Character cell width (for coordinate conversion). */
  public get charWidth(): number {
    return this.settings.metrics.width;
  }

  /** Character cell height (for coordinate conversion). */
  public get charHeight(): number {
    return this.settings.metrics.height;
  }

  /** Clears the entire canvas; the next frame repaints every row. */
  public clear(): void {
    this.counter.draws++;
    // clearRect first because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this.settings.theme.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvasStale = true;
  }

  /** Stops the blink and the ratio watch, removes the drawing canvas and frees the scratch. */
  public dispose(): void {
    this.disposables.dispose();
    this.canvas.remove?.();
    this.repainter.freeScratch();
  }
}
