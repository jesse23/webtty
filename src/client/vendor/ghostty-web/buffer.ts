/**
 * Buffer API - xterm.js-compatible buffer access
 *
 * Provides read-only access to terminal buffer contents, cursor state,
 * and viewport position. Wraps Ghostty WASM terminal state.
 *
 * Usage:
 * ```typescript
 * const cell = term.buffer.active.getLine(0)?.getCell(5);
 * console.log(cell?.getCodepoint(), cell?.getHyperlinkId());
 *
 * if (term.buffer.active.type === 'alternate') {
 *   console.log('Full-screen app running');
 * }
 * ```
 */

import type { GhosttyTerminal } from './ghostty';
import type { IBuffer, IBufferCell, IBufferLine, IBufferNamespace } from './interfaces';
import type { Terminal } from './terminal';
import type { GhosttyCell } from './types';

// ============================================================================
// BufferNamespace - Top-level buffer API
// ============================================================================

/**
 * Top-level buffer API namespace
 * Provides access to active, normal, and alternate screen buffers
 */
export class BufferNamespace implements IBufferNamespace {
  private terminal: Terminal;

  // Lazy-initialized buffer wrappers (stateless, so we can cache them)
  private _normalBuffer?: Buffer;
  private _alternateBuffer?: Buffer;

  constructor(terminal: Terminal) {
    this.terminal = terminal;
  }

  get active(): IBuffer {
    // Query WASM to determine which buffer is active
    const wasmTerm = (this.terminal as any).wasmTerm as GhosttyTerminal | undefined;
    if (!wasmTerm) {
      return this.normal; // Default to normal if not initialized
    }

    return wasmTerm.isAlternateScreen() ? this.alternate : this.normal;
  }

  get normal(): IBuffer {
    if (!this._normalBuffer) {
      this._normalBuffer = new Buffer(this.terminal, 'normal');
    }
    return this._normalBuffer;
  }

  get alternate(): IBuffer {
    if (!this._alternateBuffer) {
      this._alternateBuffer = new Buffer(this.terminal, 'alternate');
    }
    return this._alternateBuffer;
  }
}

// ============================================================================
// Buffer - Represents a terminal buffer (normal or alternate)
// ============================================================================

/**
 * A terminal buffer (normal or alternate screen)
 */
export class Buffer implements IBuffer {
  private terminal: Terminal;
  private bufferType: 'normal' | 'alternate';

  constructor(terminal: Terminal, type: 'normal' | 'alternate') {
    this.terminal = terminal;
    this.bufferType = type;
  }

  get type(): 'normal' | 'alternate' {
    return this.bufferType;
  }

  get cursorX(): number {
    const wasmTerm = this.getWasmTerm();
    if (!wasmTerm) return 0;
    return wasmTerm.getCursor().x;
  }

  get cursorY(): number {
    const wasmTerm = this.getWasmTerm();
    if (!wasmTerm) return 0;
    return wasmTerm.getCursor().y;
  }

  get length(): number {
    const wasmTerm = this.getWasmTerm();
    if (!wasmTerm) return 0;

    if (this.bufferType === 'alternate') {
      // Alternate buffer has no scrollback, just visible rows
      return wasmTerm.rows;
    } else {
      // Normal buffer: scrollback + visible rows
      const scrollback = wasmTerm.getScrollbackLength();
      return scrollback + wasmTerm.rows;
    }
  }

  getLine(y: number): IBufferLine | undefined {
    const wasmTerm = this.getWasmTerm();
    if (!wasmTerm) return undefined;

    // Check bounds
    if (y < 0 || y >= this.length) {
      return undefined;
    }

    // Determine if accessing scrollback or visible screen
    const scrollbackLength = wasmTerm.getScrollbackLength();
    let cells: GhosttyCell[] | null;

    if (this.bufferType === 'normal' && y < scrollbackLength) {
      // Accessing scrollback
      // WASM getScrollbackLine: offset 0 = oldest, offset (length-1) = newest
      // Buffer coords: y=0 = oldest, y=(length-1) = newest
      // So scrollbackOffset = y directly!
      const scrollbackOffset = y;
      cells = wasmTerm.getScrollbackLine(scrollbackOffset);
    } else {
      // Accessing visible screen
      cells = wasmTerm.getLine(this.bufferType === 'normal' ? y - scrollbackLength : y);
    }

    if (!cells) {
      return undefined;
    }

    return new BufferLine(cells, wasmTerm.cols);
  }

  private getWasmTerm(): GhosttyTerminal | undefined {
    return (this.terminal as any).wasmTerm as GhosttyTerminal | undefined;
  }
}

// ============================================================================
// BufferLine - Represents a single line in the buffer
// ============================================================================

/**
 * A single line in the buffer
 */
export class BufferLine implements IBufferLine {
  private cells: GhosttyCell[];
  private _length: number;

  constructor(cells: GhosttyCell[], length: number) {
    this.cells = cells;
    this._length = length;
  }

  get length(): number {
    return this._length;
  }

  getCell(x: number): IBufferCell | undefined {
    if (x < 0 || x >= this._length) {
      return undefined;
    }

    if (x >= this.cells.length) {
      // Cell beyond what was returned (empty/null cell)
      return new BufferCell(
        {
          codepoint: 0,
          fg_r: 204,
          fg_g: 204,
          fg_b: 204,
          bg_r: 0,
          bg_g: 0,
          bg_b: 0,
          flags: 0,
          width: 1,
          hyperlink_id: 0,
          grapheme_len: 0,
        },
        x
      );
    }

    return new BufferCell(this.cells[x], x);
  }
}

// ============================================================================
// BufferCell - Represents a single cell in the buffer
// ============================================================================

/**
 * A single cell in the buffer
 */
export class BufferCell implements IBufferCell {
  private cell: GhosttyCell;
  private x: number;

  constructor(cell: GhosttyCell, x: number) {
    this.cell = cell;
    this.x = x;
  }

  /**
   * Get hyperlink ID for this cell (0 = no link)
   * Used by link detection system
   */
  getHyperlinkId(): number {
    return this.cell.hyperlink_id;
  }

  /**
   * Get the Unicode codepoint for this cell
   * Used by link detection system
   */
  getCodepoint(): number {
    return this.cell.codepoint;
  }
}
