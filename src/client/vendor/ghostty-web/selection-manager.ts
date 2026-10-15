// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Text selection (facade): `SelectionManager` holds the selection's two ends in absolute
// rows, its text (Ghostty's, ADR 050), copy on select and the change event, and hands the
// mouse gestures, the coordinates, the context-menu textarea and the copy chain to
// selection/ (ADR 043, ADR 051, ADR 057, ADR 061); dispose() releases all of it (ADR 065).

import type {
  SelectionCanvasSource,
  SelectionEngineSource,
  SelectionHost,
} from './core/host-types';
import type { ScreenRange } from './engine/engine-types';
import { EventEmitter } from './event-emitter';
import type { IEvent } from './interfaces';
import { pressToApp } from './mouse-route';
import type { CellRange } from './render/cell-range';
import type { AutoScrollTimers } from './selection/auto-scroll';
import { browserClipboardEnv, type ClipboardEnv, copyText } from './selection/clipboard-copy';
import { ContextMenuTextarea, type MenuTimers } from './selection/context-menu-textarea';
import {
  absoluteRowToViewport,
  type BufferPoint,
  orderedViewportRange,
  pixelToCell,
  viewportRowToAbsolute,
  wholeViewportY,
} from './selection/selection-coords';
import { type GestureDocument, type GestureHost, SelectionGestures } from './selection/selection-gestures';

/** A selection's start and end cell, rows inclusive: the one cell range shape (ADR 061). */
export type SelectionCoordinates = CellRange;

/** The browser globals the manager uses, injected by tests; production reads the page's. */
export interface SelectionDeps {
  document?: GestureDocument & ClipboardEnv['document'];
  timers?: AutoScrollTimers;
  /** The timeout the context menu's reset waits on. */
  menuTimers?: MenuTimers;
  /** The clipboard a copy goes to; by default the page's, read at each copy. */
  clipboard?: () => ClipboardEnv;
}

/** Owns the selection: its ends in absolute rows, its text, copy and the change event. */
export class SelectionManager {
  // The ends in ABSOLUTE buffer rows (viewportY + viewportRow), so the selection
  // persists correctly when scrolling
  private selectionStart: BufferPoint | null = null;
  private selectionEnd: BufferPoint | null = null;

  private readonly selectionChangedEmitter = new EventEmitter<void>();
  private readonly gestures: SelectionGestures;
  private readonly contextMenu: ContextMenuTextarea;
  private readonly clipboard: () => ClipboardEnv;

  constructor(
    private readonly terminal: SelectionHost,
    private readonly renderer: SelectionCanvasSource,
    private readonly wasmTerm: SelectionEngineSource,
    textarea: HTMLTextAreaElement,
    deps: SelectionDeps = {},
  ) {
    const doc = deps.document ?? document;
    this.clipboard = deps.clipboard ?? (() => browserClipboardEnv(textarea, doc));
    this.contextMenu = new ContextMenuTextarea(textarea, doc, deps.menuTimers);
    this.gestures = new SelectionGestures(
      renderer.getCanvas(),
      doc,
      this.gestureHost(),
      deps.timers,
    );
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  getSelection(): string {
    if (!this.selectionStart || !this.selectionEnd) return '';
    // Absolute rows are Ghostty's screen rows. Ghostty builds the text as it copies:
    // soft-wrapped rows joined, trailing spaces trimmed, spacer cells skipped. (ADR 050)
    const { col: startCol, absoluteRow: startRow } = this.selectionStart;
    const { col: endCol, absoluteRow: endRow } = this.selectionEnd;
    return this.wasmTerm.selectionText(
      { col: startCol, row: startRow },
      { col: endCol, row: endRow },
    );
  }

  /**
   * Check if there's an active selection
   */
  hasSelection(): boolean {
    if (!this.selectionStart || !this.selectionEnd) return false;
    // Don't report selection until drag threshold is met (prevents flash on click)
    return !this.gestures.pressPending;
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  copySelection(): boolean {
    if (!this.hasSelection()) return false;
    const text = this.getSelection();
    if (!text) return false;
    copyText(text, this.clipboard());
    return true;
  }

  /**
   * Clear the selection. The render loop picks up the change and redraws the rows that
   * were selected.
   */
  clearSelection(): void {
    if (!this.hasSelection()) return;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.gestures.endDrag();
  }

  /**
   * The selection in viewport rows, not clamped to the viewport: rows above it are
   * negative. The renderer also draws rows out of view. (webtty, ADR 043)
   */
  getSelectionRange(): SelectionCoordinates | null {
    if (!this.selectionStart || !this.selectionEnd) return null;
    return orderedViewportRange(this.selectionStart, this.selectionEnd, (row) =>
      absoluteRowToViewport(row, this.wasmTerm.getScrollbackLength(), this.viewportY()),
    );
  }

  /**
   * Get selection change event accessor
   */
  get onSelectionChange(): IEvent<void> {
    return this.selectionChangedEmitter.event;
  }

  /**
   * Releases everything it added: the emitter, the auto-scroll, every gesture listener and
   * the context menu's wait and close listeners (ADR 065).
   */
  dispose(): void {
    this.selectionChangedEmitter.dispose();
    this.gestures.dispose();
    this.contextMenu.dispose();
  }

  /**
   * Shows the browser's menu on the textarea at the pointer, holding the selection, so
   * the menu offers Copy and Paste. The terminal calls it when a right-click shows the
   * menu (webtty: upstream listened to every contextmenu itself, ADR 051).
   */
  prepareContextMenu(e: MouseEvent): void {
    this.contextMenu.show(e, this.hasSelection() ? this.getSelection() : null);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /** Lines scrolled into history, as a whole number. */
  private viewportY(): number {
    return wholeViewportY(this.terminal.getViewportY());
  }

  /** A viewport row as an absolute buffer row. */
  private toAbsolute(viewportRow: number): number {
    return viewportRowToAbsolute(
      viewportRow,
      this.wasmTerm.getScrollbackLength(),
      this.viewportY(),
    );
  }

  /** The gestures' view of the grid and the selection. */
  private gestureHost(): GestureHost {
    const { terminal, renderer, wasmTerm } = this;
    return {
      pointAt: (x, y) => {
        const metrics = renderer.getMetrics();
        const cell = pixelToCell(x, y, {
          cellWidth: metrics.width,
          cellHeight: metrics.height,
          scrollOffset: renderer.scrollOffset,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        return { col: cell.col, absoluteRow: this.toAbsolute(cell.row) };
      },
      cellWidth: () => renderer.getMetrics().width,
      // The app takes a press while it tracks the mouse and Shift is up (webtty, ADR 051)
      appTakesPress: (e) => pressToApp(wasmTerm.hasMouseTracking(), e.shiftKey),
      clickRange: (clicks, at, e) => this.clickRange(clicks, at, e),
      scrollLines: (amount) => terminal.scrollLines(amount),
      visibleRows: () => {
        const dims = wasmTerm.getDimensions();
        return {
          top: this.toAbsolute(0),
          bottom: this.toAbsolute(dims.rows - 1),
          lastCol: dims.cols - 1,
        };
      },
      hasSelection: () => this.hasSelection(),
      clearSelection: () => this.clearSelection(),
      select: (start, end) => {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      selectionEnd: () => this.selectionEnd,
      extendTo: (end) => {
        this.selectionEnd = end;
      },
      selectionMade: () => this.selectionMade(),
    };
  }

  /** Ghostty's word (2 clicks), line (3), or with Ctrl or Cmd command output, at a point. */
  private clickRange(clicks: number, at: BufferPoint, e: MouseEvent): ScreenRange | null {
    const cell = { col: at.col, row: at.absoluteRow };
    if (clicks === 2) return this.wasmTerm.selectWord(cell);
    return e.ctrlKey || e.metaKey
      ? this.wasmTerm.selectOutput(cell)
      : this.wasmTerm.selectLine(cell);
  }

  /**
   * A mouse selection is made: with the terminal's copyOnSelect on, copy it, building
   * its text once, and clear it, as Claude Code and pi do with their own selections;
   * report the change. (webtty)
   */
  private selectionMade(): void {
    if (this.terminal.options.copyOnSelect) {
      const text = this.getSelection();
      if (text) copyText(text, this.clipboard());
      this.clearSelection();
    }
    this.selectionChangedEmitter.fire();
  }
}
