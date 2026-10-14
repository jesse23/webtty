/**
 * Selection Manager - Handles text selection in the terminal
 *
 * Features:
 * - Mouse drag selection
 * - Double-click word and triple-click line selection (Ghostty's, ADR 050), and
 *   Ctrl/Cmd+triple-click command output (Ghostty's, webtty ADR 057)
 * - Text extraction (Ghostty's, ADR 050)
 * - Clipboard copy on select (the terminal's copyOnSelect option)
 * - Visual selection highlighting (integrated into CanvasRenderer cell rendering)
 * - Auto-scroll during drag selection
 */

import { EventEmitter } from './event-emitter';
import type { GhosttyTerminal } from './ghostty';
import type { IEvent } from './interfaces';
import { pressToApp } from './mouse-route';
import type { CanvasRenderer } from './renderer';
import type { Terminal } from './terminal';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SelectionCoordinates {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
}

// ============================================================================
// SelectionManager Class
// ============================================================================

export class SelectionManager {
  private terminal: Terminal;
  private renderer: CanvasRenderer;
  private wasmTerm: GhosttyTerminal;
  private textarea: HTMLTextAreaElement;

  // Selection state - coordinates are in ABSOLUTE buffer space (viewportY + viewportRow)
  // This ensures selection persists correctly when scrolling
  private selectionStart: { col: number; absoluteRow: number } | null = null;
  private selectionEnd: { col: number; absoluteRow: number } | null = null;
  private isSelecting: boolean = false;
  private mouseDownX: number = 0;
  private mouseDownY: number = 0;
  private dragThresholdMet: boolean = false;
  private mouseDownTarget: EventTarget | null = null; // Track where mousedown occurred

  // Event emitter
  private selectionChangedEmitter = new EventEmitter<void>();

  // Store bound event handlers for cleanup
  private boundMouseUpHandler: ((e: MouseEvent) => void) | null = null;
  private boundClickHandler: ((e: MouseEvent) => void) | null = null;
  private boundDocumentMouseMoveHandler: ((e: MouseEvent) => void) | null = null;

  // Auto-scroll state for drag selection
  private autoScrollInterval: ReturnType<typeof setInterval> | null = null;
  private autoScrollDirection: number = 0; // -1 = up, 0 = none, 1 = down
  private static readonly AUTO_SCROLL_EDGE_SIZE = 30; // pixels from edge to trigger scroll

  /**
   * Get current viewport Y position (how many lines scrolled into history)
   */
  private getViewportY(): number {
    const rawViewportY =
      typeof (this.terminal as any).getViewportY === 'function'
        ? (this.terminal as any).getViewportY()
        : (this.terminal as any).viewportY || 0;
    return Math.max(0, Math.floor(rawViewportY));
  }

  /**
   * Convert viewport row to absolute buffer row
   * Absolute row is an index into combined buffer: scrollback (0 to len-1) + screen (len to len+rows-1)
   */
  private viewportRowToAbsolute(viewportRow: number): number {
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    const viewportY = this.getViewportY();
    return scrollbackLength + viewportRow - viewportY;
  }

  /**
   * Convert absolute buffer row to viewport row (may be outside visible range)
   */
  private absoluteRowToViewport(absoluteRow: number): number {
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    const viewportY = this.getViewportY();
    return absoluteRow - scrollbackLength + viewportY;
  }
  private static readonly AUTO_SCROLL_SPEED = 3; // lines per interval
  private static readonly AUTO_SCROLL_INTERVAL = 50; // ms between scroll steps

  constructor(
    terminal: Terminal,
    renderer: CanvasRenderer,
    wasmTerm: GhosttyTerminal,
    textarea: HTMLTextAreaElement
  ) {
    this.terminal = terminal;
    this.renderer = renderer;
    this.wasmTerm = wasmTerm;
    this.textarea = textarea;

    // Attach mouse event listeners
    this.attachEventListeners();
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
      { col: endCol, row: endRow }
    );
  }

  /**
   * Check if there's an active selection
   */
  hasSelection(): boolean {
    if (!this.selectionStart || !this.selectionEnd) return false;

    // Don't report selection until drag threshold is met (prevents flash on click)
    if (this.isSelecting && !this.dragThresholdMet) return false;

    return true;
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  copySelection(): boolean {
    if (!this.hasSelection()) return false;

    const text = this.getSelection();
    if (text) {
      this.copyToClipboard(text);
      return true;
    }
    return false;
  }

  /**
   * Clear the selection
   */
  clearSelection(): void {
    if (!this.hasSelection()) return;

    this.selectionStart = null;
    this.selectionEnd = null;
    this.isSelecting = false;

    // Force redraw of previously selected lines to clear the overlay
    this.requestRender();
  }

  /**
   * The selection in viewport rows, not clamped to the viewport: rows above it are
   * negative. The renderer also draws rows out of view. (webtty, ADR 043)
   */
  getSelectionRange(): SelectionCoordinates | null {
    if (!this.selectionStart || !this.selectionEnd) return null;

    let { col: startCol, absoluteRow: startAbsRow } = this.selectionStart;
    let { col: endCol, absoluteRow: endAbsRow } = this.selectionEnd;

    // Swap if selection goes backwards
    if (startAbsRow > endAbsRow || (startAbsRow === endAbsRow && startCol > endCol)) {
      [startCol, endCol] = [endCol, startCol];
      [startAbsRow, endAbsRow] = [endAbsRow, startAbsRow];
    }

    return {
      startCol,
      startRow: this.absoluteRowToViewport(startAbsRow),
      endCol,
      endRow: this.absoluteRowToViewport(endAbsRow),
    };
  }

  /**
   * Get selection change event accessor
   */
  get onSelectionChange(): IEvent<void> {
    return this.selectionChangedEmitter.event;
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.selectionChangedEmitter.dispose();

    // Stop auto-scroll if active
    this.stopAutoScroll();

    // Clean up document event listener
    if (this.boundMouseUpHandler) {
      document.removeEventListener('mouseup', this.boundMouseUpHandler);
      this.boundMouseUpHandler = null;
    }

    // Clean up document mousemove listener
    if (this.boundDocumentMouseMoveHandler) {
      document.removeEventListener('mousemove', this.boundDocumentMouseMoveHandler);
      this.boundDocumentMouseMoveHandler = null;
    }

    // Clean up document click listener
    if (this.boundClickHandler) {
      document.removeEventListener('click', this.boundClickHandler);
      this.boundClickHandler = null;
    }

    // Canvas event listeners will be cleaned up when canvas is removed from DOM
  }

  /**
   * Shows the browser's menu on the textarea at the pointer, holding the selection, so
   * the menu offers Copy and Paste. The terminal calls it when a right-click shows the
   * menu (webtty: upstream listened to every contextmenu itself, ADR 051).
   */
  prepareContextMenu(e: MouseEvent): void {
    // Position textarea at mouse cursor
    const canvas = this.renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();

    this.textarea.style.position = 'fixed';
    this.textarea.style.left = `${e.clientX}px`;
    this.textarea.style.top = `${e.clientY}px`;
    this.textarea.style.width = '1px';
    this.textarea.style.height = '1px';
    this.textarea.style.zIndex = '1000';
    this.textarea.style.opacity = '0';

    // Enable pointer events temporarily so context menu targets the textarea
    this.textarea.style.pointerEvents = 'auto';

    // If there's a selection, populate textarea with it and select the text
    if (this.hasSelection()) {
      const text = this.getSelection();
      this.textarea.value = text;
      this.textarea.select();
      this.textarea.setSelectionRange(0, text.length);
    } else {
      // No selection - clear textarea but still show menu (for paste)
      this.textarea.value = '';
    }

    // Focus the textarea so the context menu appears on it
    this.textarea.focus();

    // After a short delay, restore the textarea to its hidden state
    // This allows the context menu to appear first
    setTimeout(() => {
      // Listen for when the context menu closes (user clicks away or selects an option)
      const resetTextarea = () => {
        this.textarea.style.pointerEvents = 'none';
        this.textarea.style.zIndex = '-10';
        this.textarea.style.width = '0';
        this.textarea.style.height = '0';
        this.textarea.style.left = '0';
        this.textarea.style.top = '0';
        this.textarea.value = '';

        // Remove the one-time listeners
        document.removeEventListener('click', resetTextarea);
        document.removeEventListener('contextmenu', resetTextarea);
        this.textarea.removeEventListener('blur', resetTextarea);
      };

      // Reset on any of these events (menu closed)
      document.addEventListener('click', resetTextarea, { once: true });
      document.addEventListener('contextmenu', resetTextarea, { once: true });
      this.textarea.addEventListener('blur', resetTextarea, { once: true });
    }, 10);

    // Don't prevent default - let browser show the context menu on the textarea
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Attach mouse event listeners to canvas
   */
  private attachEventListeners(): void {
    const canvas = this.renderer.getCanvas();

    // Mouse down - start selection or clear existing
    canvas.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button === 0) {
        // Left click only

        // CRITICAL: Focus the terminal so it can receive keyboard input
        // The canvas doesn't have tabindex, but the parent container does
        if (canvas.parentElement) {
          canvas.parentElement.focus();
        }

        // A press the app takes (it tracks the mouse, Shift is up) starts no selection
        // and leaves the current one; Shift selects here instead. (webtty, ADR 051)
        if (this.pressIsApps(e)) return;

        const cell = this.pixelToCell(e.offsetX, e.offsetY);

        // Always clear previous selection on new click
        const hadSelection = this.hasSelection();
        if (hadSelection) {
          this.clearSelection();
        }

        // Start new selection (convert to absolute coordinates)
        const absoluteRow = this.viewportRowToAbsolute(cell.row);
        this.selectionStart = { col: cell.col, absoluteRow };
        this.selectionEnd = { col: cell.col, absoluteRow };
        this.isSelecting = true;
        this.mouseDownX = e.offsetX;
        this.mouseDownY = e.offsetY;
        this.dragThresholdMet = false;
      }
    });

    // Mouse move on canvas - update selection
    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      if (this.isSelecting) {
        // Check if drag threshold has been met
        if (!this.dragThresholdMet) {
          const dx = e.offsetX - this.mouseDownX;
          const dy = e.offsetY - this.mouseDownY;
          // Use 50% of cell width as threshold to scale with font size
          const threshold = this.renderer.getMetrics().width * 0.5;
          if (dx * dx + dy * dy < threshold * threshold) {
            return; // Below threshold, ignore
          }
          this.dragThresholdMet = true;
        }

        const cell = this.pixelToCell(e.offsetX, e.offsetY);
        const absoluteRow = this.viewportRowToAbsolute(cell.row);
        this.selectionEnd = { col: cell.col, absoluteRow };
        this.requestRender();

        // Check if near edges for auto-scroll
        this.updateAutoScroll(e.offsetY, canvas.clientHeight);
      }
    });

    // Mouse leave - check for auto-scroll when leaving canvas during drag
    canvas.addEventListener('mouseleave', (e: MouseEvent) => {
      if (this.isSelecting) {
        // Determine scroll direction based on where mouse left
        const rect = canvas.getBoundingClientRect();
        if (e.clientY < rect.top) {
          this.startAutoScroll(-1); // Scroll up
        } else if (e.clientY > rect.bottom) {
          this.startAutoScroll(1); // Scroll down
        }
      }
    });

    // Mouse enter - stop auto-scroll when mouse returns to canvas
    canvas.addEventListener('mouseenter', () => {
      if (this.isSelecting) {
        this.stopAutoScroll();
      }
    });

    // Document-level mousemove for tracking mouse position during drag outside canvas
    this.boundDocumentMouseMoveHandler = (e: MouseEvent) => {
      if (this.isSelecting) {
        // Check drag threshold (same as canvas mousemove)
        if (!this.dragThresholdMet) {
          const dx = e.clientX - (canvas.getBoundingClientRect().left + this.mouseDownX);
          const dy = e.clientY - (canvas.getBoundingClientRect().top + this.mouseDownY);
          const threshold = this.renderer.getMetrics().width * 0.5;
          if (dx * dx + dy * dy < threshold * threshold) {
            return;
          }
          this.dragThresholdMet = true;
        }

        const rect = canvas.getBoundingClientRect();

        // Update selection based on clamped position
        const clampedX = Math.max(rect.left, Math.min(e.clientX, rect.right));
        const clampedY = Math.max(rect.top, Math.min(e.clientY, rect.bottom));

        // Convert to canvas-relative coordinates
        const offsetX = clampedX - rect.left;
        const offsetY = clampedY - rect.top;

        // Only update if mouse is outside the canvas
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        ) {
          // Update auto-scroll direction based on mouse position
          if (e.clientY < rect.top) {
            this.startAutoScroll(-1);
          } else if (e.clientY > rect.bottom) {
            this.startAutoScroll(1);
          } else {
            this.stopAutoScroll();
          }

          // Only update selection position if NOT auto-scrolling
          // During auto-scroll, the scroll handler extends the selection
          if (this.autoScrollDirection === 0) {
            const cell = this.pixelToCell(offsetX, offsetY);
            const absoluteRow = this.viewportRowToAbsolute(cell.row);
            this.selectionEnd = { col: cell.col, absoluteRow };
            this.requestRender();
          }
        }
      }
    };
    document.addEventListener('mousemove', this.boundDocumentMouseMoveHandler);

    // Track mousedown on document to know if a click started inside the canvas
    document.addEventListener('mousedown', (e: MouseEvent) => {
      this.mouseDownTarget = e.target;
    });

    // CRITICAL FIX: Listen for mouseup on DOCUMENT, not just canvas
    // This catches mouseup events that happen outside the canvas (common during drag)
    this.boundMouseUpHandler = (e: MouseEvent) => {
      if (this.isSelecting) {
        this.isSelecting = false;
        this.stopAutoScroll();

        // Check if this was a click without drag (threshold never met).
        if (!this.dragThresholdMet) {
          this.clearSelection();
          return;
        }

        if (this.hasSelection()) this.selectionMade();
      }
    };
    document.addEventListener('mouseup', this.boundMouseUpHandler);

    // Double click selects a word and triple click a line, by Ghostty's rules (ADR 050);
    // with Ctrl or Cmd, triple click selects the command's output (webtty, ADR 057).
    // event.detail is the browser's click count.
    // Not while the app takes the press (webtty, ADR 051).
    canvas.addEventListener('click', (e: MouseEvent) => {
      if (e.detail < 2) return;
      if (this.pressIsApps(e)) return;
      const cell = this.pixelToCell(e.offsetX, e.offsetY);
      const at = { col: cell.col, row: this.viewportRowToAbsolute(cell.row) };
      const range =
        e.detail === 2
          ? this.wasmTerm.selectWord(at)
          : e.ctrlKey || e.metaKey
            ? this.wasmTerm.selectOutput(at)
            : this.wasmTerm.selectLine(at);
      if (!range) return;
      this.selectionStart = { col: range.start.col, absoluteRow: range.start.row };
      this.selectionEnd = { col: range.end.col, absoluteRow: range.end.row };
      this.requestRender();
      this.selectionMade();
    });

    // Click outside canvas - clear selection
    // This allows users to deselect by clicking anywhere outside the terminal
    this.boundClickHandler = (e: MouseEvent) => {
      // Don't clear selection if we're actively selecting
      if (this.isSelecting) {
        return;
      }

      // A click is only valid for clearing selection if BOTH mousedown and mouseup
      // happened outside the canvas. If mousedown was inside (drag selection),
      // don't clear even if mouseup/click is outside.
      const mouseDownWasInCanvas =
        this.mouseDownTarget && canvas.contains(this.mouseDownTarget as Node);
      if (mouseDownWasInCanvas) {
        return;
      }

      // Check if the click is outside the canvas
      const target = e.target as Node;
      if (!canvas.contains(target)) {
        // Clicked outside the canvas - clear selection
        if (this.hasSelection()) {
          this.clearSelection();
        }
      }
    };

    document.addEventListener('click', this.boundClickHandler);
  }

  /** Whether the app takes this press: it tracks the mouse and Shift is up. (webtty, ADR 051) */
  private pressIsApps(e: MouseEvent): boolean {
    return pressToApp(this.wasmTerm.hasMouseTracking(), e.shiftKey);
  }

  /**
   * Update auto-scroll based on mouse Y position within canvas
   */
  private updateAutoScroll(offsetY: number, canvasHeight: number): void {
    const edgeSize = SelectionManager.AUTO_SCROLL_EDGE_SIZE;

    if (offsetY < edgeSize) {
      // Near top edge - scroll up
      this.startAutoScroll(-1);
    } else if (offsetY > canvasHeight - edgeSize) {
      // Near bottom edge - scroll down
      this.startAutoScroll(1);
    } else {
      // In middle - stop scrolling
      this.stopAutoScroll();
    }
  }

  /**
   * Start auto-scrolling in the given direction
   */
  private startAutoScroll(direction: number): void {
    // Don't restart if already scrolling in same direction
    if (this.autoScrollInterval !== null && this.autoScrollDirection === direction) {
      return;
    }

    // Stop any existing scroll
    this.stopAutoScroll();

    this.autoScrollDirection = direction;

    // Start scrolling interval
    this.autoScrollInterval = setInterval(() => {
      if (!this.isSelecting) {
        this.stopAutoScroll();
        return;
      }

      // Scroll the terminal to reveal more content in the direction user is dragging
      // autoScrollDirection: -1 = dragging up (wants to see history), 1 = dragging down (wants to see newer)
      // scrollLines convention: negative = scroll up into history, positive = scroll down to newer
      // So direction maps directly to scrollLines sign
      const scrollAmount = SelectionManager.AUTO_SCROLL_SPEED * this.autoScrollDirection;
      this.terminal.scrollLines(scrollAmount);

      // Extend selection in the scroll direction
      // Key insight: we need to EXTEND the selection, not reset it to viewport edge
      if (this.selectionEnd) {
        const dims = this.wasmTerm.getDimensions();
        if (this.autoScrollDirection < 0) {
          // Scrolling up - extend selection upward (decrease absoluteRow)
          // Set to top of viewport, but only if it extends the selection
          const topAbsoluteRow = this.viewportRowToAbsolute(0);
          if (topAbsoluteRow < this.selectionEnd.absoluteRow) {
            this.selectionEnd = { col: 0, absoluteRow: topAbsoluteRow };
          }
        } else {
          // Scrolling down - extend selection downward (increase absoluteRow)
          // Set to bottom of viewport, but only if it extends the selection
          const bottomAbsoluteRow = this.viewportRowToAbsolute(dims.rows - 1);
          if (bottomAbsoluteRow > this.selectionEnd.absoluteRow) {
            this.selectionEnd = { col: dims.cols - 1, absoluteRow: bottomAbsoluteRow };
          }
        }
      }

      this.requestRender();
    }, SelectionManager.AUTO_SCROLL_INTERVAL);
  }

  /**
   * Stop auto-scrolling
   */
  private stopAutoScroll(): void {
    if (this.autoScrollInterval !== null) {
      clearInterval(this.autoScrollInterval);
      this.autoScrollInterval = null;
    }
    this.autoScrollDirection = 0;
  }

  /**
   * Convert pixel coordinates to terminal cell coordinates
   */
  private pixelToCell(x: number, y: number): { col: number; row: number } {
    const metrics = this.renderer.getMetrics();

    const col = Math.floor(x / metrics.width);
    // Viewport row 0 starts the scroll offset below the canvas top (webtty, ADR 043)
    const row = Math.floor((y - this.renderer.scrollOffset) / metrics.height);

    // Clamp to terminal bounds
    return {
      col: Math.max(0, Math.min(col, this.terminal.cols - 1)),
      row: Math.max(0, Math.min(row, this.terminal.rows - 1)),
    };
  }

  /**
   * A mouse selection is made: with the terminal's copyOnSelect on, copy it, building
   * its text once, and clear it, as Claude Code and pi do with their own selections;
   * report the change. (webtty)
   */
  private selectionMade(): void {
    if (this.terminal.options.copyOnSelect) {
      const text = this.getSelection();
      if (text) this.copyToClipboard(text);
      this.clearSelection();
    }
    this.selectionChangedEmitter.fire();
  }

  /**
   * Copy text to clipboard
   *
   * Strategy (modern APIs first):
   * 1. Try ClipboardItem API (works in Safari and modern browsers)
   *    - Safari requires the ClipboardItem to be created synchronously within user gesture
   * 2. Try navigator.clipboard.writeText (modern async API, may fail in Safari)
   * 3. Fall back to execCommand (legacy, for older browsers)
   */
  private copyToClipboard(text: string): void {
    // First try: ClipboardItem API (modern, Safari-compatible)
    // Safari allows this because we create the ClipboardItem synchronously
    // within the user gesture, even though the write is async
    if (navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      try {
        const blob = new Blob([text], { type: 'text/plain' });
        const clipboardItem = new ClipboardItem({
          'text/plain': blob,
        });
        navigator.clipboard.write([clipboardItem]).catch((err) => {
          console.warn('ClipboardItem write failed, trying writeText:', err);
          // Try writeText as fallback
          this.copyWithWriteText(text);
        });
        return;
      } catch (err) {
        // ClipboardItem not supported or failed, fall through
      }
    }

    // Second try: basic async writeText (works in Chrome, may fail in Safari)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn('Clipboard writeText failed, trying execCommand:', err);
        // Fall back to execCommand
        this.copyWithExecCommand(text);
      });
      return;
    }

    // Third try: legacy execCommand fallback
    this.copyWithExecCommand(text);
  }

  /**
   * Copy using navigator.clipboard.writeText
   */
  private copyWithWriteText(text: string): void {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        console.warn('Clipboard writeText failed, trying execCommand:', err);
        this.copyWithExecCommand(text);
      });
    } else {
      this.copyWithExecCommand(text);
    }
  }

  /**
   * Copy using legacy execCommand (fallback for older browsers)
   */
  private copyWithExecCommand(text: string): void {
    const previouslyFocused = document.activeElement as HTMLElement;
    try {
      // Position textarea offscreen but in a way that allows selection
      const textarea = this.textarea;
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.style.width = '1px';
      textarea.style.height = '1px';
      textarea.style.opacity = '0';

      // Select all text and copy
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, text.length);

      const success = document.execCommand('copy');

      // Restore focus
      if (previouslyFocused) {
        previouslyFocused.focus();
      }

      if (!success) {
        console.warn('execCommand copy failed');
      }
    } catch (err) {
      console.warn('execCommand copy threw:', err);
      // Restore focus on error
      if (previouslyFocused) {
        previouslyFocused.focus();
      }
    }
  }

  /**
   * Request a render update (triggers selection overlay redraw)
   */
  private requestRender(): void {
    // The render loop will automatically pick up the new selection state
    // and redraw the affected lines. This happens at 60fps.
  }
}
