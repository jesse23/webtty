/**
 * TypeScript wrapper for libghostty-vt WASM API
 *
 * High-performance terminal emulation using Ghostty's battle-tested VT100 parser.
 * The key optimization is the RenderState API which provides a pre-computed
 * snapshot of all render data in a single update call.
 *
 * webtty (ADR 042): two engines behind one `GhosttyTerminal` interface. The Coder
 * engine (`CoderTerminal`) runs ghostty-web's patched wasm; the official engine
 * (`OfficialTerminal`) runs Ghostty's unpatched libghostty-vt wasm. Every wasm
 * export call and wasm memory access for both engines is in this file.
 */

import { FnTable, type InstalledFn, WasmValType } from './fn-table';
import {
  CellFlags,
  type Cursor,
  DirtyState,
  GHOSTTY_CONFIG_SIZE,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  type GhosttyWasmExports,
  Key,
  KeyAction,
  KeyEncoderOption,
  type KeyEvent,
  type KittyKeyFlags,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
  type TerminalHandle,
} from './types';

// Re-export types for convenience
export {
  CellFlags,
  type Cursor,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RGB,
  type RenderStateColors,
  type RenderStateCursor,
};

/** The terminal engines (ADR 042). */
export type EngineName = 'coder' | 'official';

/** Bell and title changes since the last `readEffects` (ADR 042). */
export interface TerminalEffects {
  bell: boolean;
  title: string | null;
}

/**
 * The terminal surface the renderer, selection, buffer, input handler and
 * terminal.ts use. Rows are in the Coder engine's coordinates on both engines:
 * `getLine(n)`, `getViewport`, `getCursor` and `isRowDirty(n)` use active-screen
 * rows, and `getScrollbackLine(i)` counts from the oldest scrollback row.
 */
export interface GhosttyTerminal {
  readonly cols: number;
  readonly rows: number;
  /** True when the engine answers XTWINOPS size queries and mode 2048 itself. */
  readonly answersSizeQueries: boolean;

  // Lifecycle
  write(data: string | Uint8Array): void;
  /** Grid resize; the device-pixel cell size is used by the official engine only. */
  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): void;
  /** Device-pixel cell size for size reports. A no-op on the Coder engine. */
  setCellPixelSize(cellWidthPx: number, cellHeightPx: number): void;
  /**
   * The view's `viewportY` (lines scrolled up from the bottom). The renderer calls
   * it first in every render. Only the official engine implements it.
   */
  setViewportOffset?(linesFromBottom: number): void;
  free(): void;

  // Render state
  update(): DirtyState;
  getCursor(): RenderStateCursor;
  getColors(): RenderStateColors;
  isRowDirty(y: number): boolean;
  markClean(): void;
  getViewport(): GhosttyCell[];
  getLine(y: number): GhosttyCell[] | null;
  isDirty(): boolean;
  needsFullRedraw(): boolean;
  clearDirty(): void;
  getDimensions(): { cols: number; rows: number };

  // Modes
  isAlternateScreen(): boolean;
  hasBracketedPaste(): boolean;
  hasFocusEvents(): boolean;
  hasMouseTracking(): boolean;
  getMode(mode: number, isAnsi?: boolean): boolean;

  // Scrollback, graphemes, hyperlinks
  getScrollbackLength(): number;
  getScrollbackLine(offset: number): GhosttyCell[] | null;
  isRowWrapped(row: number): boolean;
  getHyperlinkUri(row: number, col: number): string | null;
  getScrollbackHyperlinkUri(offset: number, col: number): string | null;
  getGrapheme(row: number, col: number): number[] | null;
  getGraphemeString(row: number, col: number): string;
  getScrollbackGrapheme(offset: number, col: number): number[] | null;
  getScrollbackGraphemeString(offset: number, col: number): string;

  // Replies and effects
  hasResponse(): boolean;
  readResponse(): string | null;
  /** Bell and title changes since the last call. The Coder engine reports none. */
  readEffects(): TerminalEffects;
}

/** Converts keyboard events into terminal escape sequences. */
export interface KeyEncoder {
  setOption(option: KeyEncoderOption, value: boolean | number): void;
  setKittyFlags(flags: KittyKeyFlags): void;
  encode(event: KeyEvent): Uint8Array;
  dispose(): void;
}

/**
 * A loaded engine: one wasm instance that creates terminals and key encoders.
 */
export abstract class Ghostty {
  abstract readonly engine: EngineName;

  abstract createKeyEncoder(): KeyEncoder;

  abstract createTerminal(cols?: number, rows?: number, config?: GhosttyTerminalConfig): GhosttyTerminal;

  static async load(wasmPath?: string, engine: EngineName = 'coder'): Promise<Ghostty> {
    // If explicit path provided, use it
    if (wasmPath) {
      return Ghostty.loadFromPath(wasmPath, engine);
    }

    // Resolve path relative to this module
    const moduleUrl = new URL(
      engine === 'official' ? '../ghostty-vt/ghostty-vt-small.wasm' : '../ghostty-vt.wasm',
      import.meta.url
    );

    // Build paths to try, prioritizing file system paths for Node/Bun
    const defaultPaths: string[] = [];

    // For Node/Bun: try absolute file path first (strip file:// protocol)
    if (moduleUrl.protocol === 'file:') {
      let filePath = moduleUrl.pathname;
      // Remove leading slash on Windows paths (e.g., /C:/ -> C:/)
      if (filePath.match(/^\/[A-Za-z]:\//)) {
        filePath = filePath.slice(1);
      }
      defaultPaths.push(filePath);
    }

    // Also try other common paths
    defaultPaths.push(moduleUrl.href, './ghostty-vt.wasm', '/ghostty-vt.wasm');

    let lastError: Error | null = null;
    for (const path of defaultPaths) {
      try {
        return await Ghostty.loadFromPath(path, engine);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError || new Error('Failed to load Ghostty WASM');
  }

  private static async loadFromPath(path: string, engine: EngineName): Promise<Ghostty> {
    let wasmBytes: ArrayBuffer | undefined;

    // Try Bun.file first (for Bun environments)
    if (typeof Bun !== 'undefined' && typeof Bun.file === 'function') {
      try {
        const file = Bun.file(path);
        if (await file.exists()) {
          wasmBytes = await file.arrayBuffer();
        }
      } catch {
        // Bun.file failed, try next method
      }
    }

    // Try Node.js fs module if Bun.file didn't work
    if (!wasmBytes) {
      try {
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(path);
        wasmBytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } catch {
        // fs failed, try fetch
      }
    }

    // Fall back to fetch (for browser environments)
    if (!wasmBytes) {
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
      }
      wasmBytes = await response.arrayBuffer();
      if (wasmBytes.byteLength === 0) {
        throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
      }
    }

    if (!wasmBytes) {
      throw new Error(`Could not load WASM from path: ${path}`);
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    if (engine === 'official') {
      // The official wasm imports nothing.
      const instance = await WebAssembly.instantiate(wasmModule, {});
      return new OfficialGhostty(instance.exports as unknown as OfficialWasmExports);
    }
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {
      env: {
        log: (ptr: number, len: number) => {
          const bytes = new Uint8Array(
            (wasmInstance.exports as GhosttyWasmExports).memory.buffer,
            ptr,
            len
          );
          console.log('[ghostty-vt]', new TextDecoder().decode(bytes));
        },
      },
    });
    return new CoderGhostty(wasmInstance);
  }
}

/**
 * The Coder engine: ghostty-web's patched wasm.
 */
class CoderGhostty extends Ghostty {
  readonly engine = 'coder' as const;
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;

  constructor(wasmInstance: WebAssembly.Instance) {
    super();
    this.exports = wasmInstance.exports as GhosttyWasmExports;
    this.memory = this.exports.memory;
  }

  createKeyEncoder(): KeyEncoder {
    return new CoderKeyEncoder(this.exports);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): GhosttyTerminal {
    return new CoderTerminal(this.exports, this.memory, cols, rows, config);
  }
}

/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
class CoderKeyEncoder implements KeyEncoder {
  private exports: GhosttyWasmExports;
  private encoder: number = 0;

  constructor(exports: GhosttyWasmExports) {
    this.exports = exports;
    const encoderPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    const result = this.exports.ghostty_key_encoder_new(0, encoderPtrPtr);
    if (result !== 0) throw new Error(`Failed to create key encoder: ${result}`);
    const view = new DataView(this.exports.memory.buffer);
    this.encoder = view.getUint32(encoderPtrPtr, true);
    this.exports.ghostty_wasm_free_opaque(encoderPtrPtr);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const valuePtr = this.exports.ghostty_wasm_alloc_u8();
    const view = new DataView(this.exports.memory.buffer);
    view.setUint8(valuePtr, typeof value === 'boolean' ? (value ? 1 : 0) : value);
    this.exports.ghostty_key_encoder_setopt(this.encoder, option, valuePtr);
    this.exports.ghostty_wasm_free_u8(valuePtr);
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  encode(event: KeyEvent): Uint8Array {
    const eventPtrPtr = this.exports.ghostty_wasm_alloc_opaque();
    const createResult = this.exports.ghostty_key_event_new(0, eventPtrPtr);
    if (createResult !== 0) throw new Error(`Failed to create key event: ${createResult}`);

    const view = new DataView(this.exports.memory.buffer);
    const eventPtr = view.getUint32(eventPtrPtr, true);
    this.exports.ghostty_wasm_free_opaque(eventPtrPtr);

    this.exports.ghostty_key_event_set_action(eventPtr, event.action);
    this.exports.ghostty_key_event_set_key(eventPtr, event.key);
    this.exports.ghostty_key_event_set_mods(eventPtr, event.mods);

    if (event.utf8) {
      const encoder = new TextEncoder();
      const utf8Bytes = encoder.encode(event.utf8);
      const utf8Ptr = this.exports.ghostty_wasm_alloc_u8_array(utf8Bytes.length);
      new Uint8Array(this.exports.memory.buffer).set(utf8Bytes, utf8Ptr);
      this.exports.ghostty_key_event_set_utf8(eventPtr, utf8Ptr, utf8Bytes.length);
      this.exports.ghostty_wasm_free_u8_array(utf8Ptr, utf8Bytes.length);
    }

    const bufferSize = 32;
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufferSize);
    const writtenPtr = this.exports.ghostty_wasm_alloc_usize();

    const encodeResult = this.exports.ghostty_key_encoder_encode(
      this.encoder,
      eventPtr,
      bufPtr,
      bufferSize,
      writtenPtr
    );

    if (encodeResult !== 0) {
      this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize);
      this.exports.ghostty_wasm_free_usize(writtenPtr);
      this.exports.ghostty_key_event_free(eventPtr);
      throw new Error(`Failed to encode key: ${encodeResult}`);
    }

    const bytesWritten = view.getUint32(writtenPtr, true);
    const encoded = new Uint8Array(this.exports.memory.buffer, bufPtr, bytesWritten).slice();

    this.exports.ghostty_wasm_free_u8_array(bufPtr, bufferSize);
    this.exports.ghostty_wasm_free_usize(writtenPtr);
    this.exports.ghostty_key_event_free(eventPtr);

    return encoded;
  }

  dispose(): void {
    if (this.encoder) {
      this.exports.ghostty_key_encoder_free(this.encoder);
      this.encoder = 0;
    }
  }
}

/**
 * GhosttyTerminal - High-performance terminal emulator
 *
 * Uses Ghostty's native RenderState for optimal performance:
 * - ONE call to update all state (renderStateUpdate)
 * - ONE call to get all cells (getViewport)
 * - No per-row WASM boundary crossings!
 */
export class CoderTerminal implements GhosttyTerminal {
  readonly answersSizeQueries = false;
  private exports: GhosttyWasmExports;
  private memory: WebAssembly.Memory;
  private handle: TerminalHandle;
  private _cols: number;
  private _rows: number;

  /** Size of GhosttyCell in WASM (16 bytes) */
  private static readonly CELL_SIZE = 16;

  /** Reusable buffer for viewport operations */
  private viewportBufferPtr: number = 0;
  private viewportBufferSize: number = 0;

  /** Cell pool for zero-allocation rendering */
  private cellPool: GhosttyCell[] = [];

  constructor(
    exports: GhosttyWasmExports,
    memory: WebAssembly.Memory,
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ) {
    this.exports = exports;
    this.memory = memory;
    this._cols = cols;
    this._rows = rows;

    if (config) {
      // Allocate config struct in WASM memory
      const configPtr = this.exports.ghostty_wasm_alloc_u8_array(GHOSTTY_CONFIG_SIZE);
      if (configPtr === 0) {
        throw new Error('Failed to allocate config (out of memory)');
      }

      try {
        // Write config to WASM memory
        const view = new DataView(this.memory.buffer);
        let offset = configPtr;

        // scrollback_limit (u32)
        view.setUint32(offset, config.scrollbackLimit ?? 10000, true);
        offset += 4;

        // fg_color (u32)
        view.setUint32(offset, config.fgColor ?? 0, true);
        offset += 4;

        // bg_color (u32)
        view.setUint32(offset, config.bgColor ?? 0, true);
        offset += 4;

        // cursor_color (u32)
        view.setUint32(offset, config.cursorColor ?? 0, true);
        offset += 4;

        // palette[16] (u32 * 16)
        for (let i = 0; i < 16; i++) {
          view.setUint32(offset, config.palette?.[i] ?? 0, true);
          offset += 4;
        }

        this.handle = this.exports.ghostty_terminal_new_with_config(cols, rows, configPtr);
      } finally {
        // Free the config memory
        this.exports.ghostty_wasm_free_u8_array(configPtr, GHOSTTY_CONFIG_SIZE);
      }
    } else {
      this.handle = this.exports.ghostty_terminal_new(cols, rows);
    }

    if (!this.handle) throw new Error('Failed to create terminal');

    this.initCellPool();
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const ptr = this.exports.ghostty_wasm_alloc_u8_array(bytes.length);
    new Uint8Array(this.memory.buffer).set(bytes, ptr);
    this.exports.ghostty_terminal_write(this.handle, ptr, bytes.length);
    this.exports.ghostty_wasm_free_u8_array(ptr, bytes.length);
  }

  /** The pixel size is for the official engine; the Coder wasm has no use for it. */
  resize(cols: number, rows: number, _cellWidthPx?: number, _cellHeightPx?: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.exports.ghostty_terminal_resize(this.handle, cols, rows);
    this.invalidateBuffers();
    this.initCellPool();
  }

  /** The Coder wasm does not answer size queries (kitty.ts does), so it needs no pixels. */
  setCellPixelSize(_cellWidthPx: number, _cellHeightPx: number): void {}

  /** The Coder wasm reports no effects; terminal.ts scans the stream for BEL and OSC 0/2. */
  readEffects(): TerminalEffects {
    return { bell: false, title: null };
  }

  free(): void {
    if (this.viewportBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      this.viewportBufferPtr = 0;
    }
    this.exports.ghostty_terminal_free(this.handle);
  }

  // ==========================================================================
  // RenderState API - The key performance optimization
  // ==========================================================================

  /**
   * Update render state from terminal.
   *
   * This syncs the RenderState with the current Terminal state.
   * The dirty state (full/partial/none) is stored in the WASM RenderState
   * and can be queried via isRowDirty(). When dirty==full, isRowDirty()
   * returns true for ALL rows.
   *
   * The WASM layer automatically detects screen switches (normal <-> alternate)
   * and returns FULL dirty state when switching screens (e.g., vim exit).
   *
   * Safe to call multiple times - dirty state persists until markClean().
   */
  update(): DirtyState {
    return this.exports.ghostty_render_state_update(this.handle) as DirtyState;
  }

  /**
   * Get cursor state from render state.
   * Ensures render state is fresh by calling update().
   */
  getCursor(): RenderStateCursor {
    // Call update() to ensure render state is fresh.
    // This is safe to call multiple times - dirty state persists until markClean().
    this.update();
    return {
      x: this.exports.ghostty_render_state_get_cursor_x(this.handle),
      y: this.exports.ghostty_render_state_get_cursor_y(this.handle),
      viewportX: this.exports.ghostty_render_state_get_cursor_x(this.handle),
      viewportY: this.exports.ghostty_render_state_get_cursor_y(this.handle),
      visible: this.exports.ghostty_render_state_get_cursor_visible(this.handle),
      blinking: false, // TODO: Add blinking support
      style: 'block', // TODO: Add style support
    };
  }

  /**
   * Get default colors from render state
   */
  getColors(): RenderStateColors {
    const bg = this.exports.ghostty_render_state_get_bg_color(this.handle);
    const fg = this.exports.ghostty_render_state_get_fg_color(this.handle);
    return {
      background: {
        r: (bg >> 16) & 0xff,
        g: (bg >> 8) & 0xff,
        b: bg & 0xff,
      },
      foreground: {
        r: (fg >> 16) & 0xff,
        g: (fg >> 8) & 0xff,
        b: fg & 0xff,
      },
      cursor: null, // TODO: Add cursor color support
    };
  }

  /**
   * Check if a specific row is dirty
   */
  isRowDirty(y: number): boolean {
    return this.exports.ghostty_render_state_is_row_dirty(this.handle, y);
  }

  /**
   * Mark render state as clean (call after rendering)
   */
  markClean(): void {
    this.exports.ghostty_render_state_mark_clean(this.handle);
  }

  /**
   * Get ALL viewport cells in ONE WASM call - the key performance optimization!
   * Returns a reusable cell array (zero allocation after warmup).
   */
  getViewport(): GhosttyCell[] {
    const totalCells = this._cols * this._rows;
    const neededSize = totalCells * CoderTerminal.CELL_SIZE;

    // Ensure buffer is allocated
    if (!this.viewportBufferPtr || this.viewportBufferSize < neededSize) {
      if (this.viewportBufferPtr) {
        this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      }
      this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededSize);
      this.viewportBufferSize = neededSize;
    }

    // Get all cells in one call
    const count = this.exports.ghostty_render_state_get_viewport(
      this.handle,
      this.viewportBufferPtr,
      totalCells
    );

    if (count < 0) return this.cellPool;

    // Parse cells into pool (reuses existing objects)
    this.parseCellsIntoPool(this.viewportBufferPtr, totalCells);
    return this.cellPool;
  }

  // ==========================================================================
  // Compatibility methods (delegate to render state)
  // ==========================================================================

  /**
   * Get line - for compatibility, extracts from viewport.
   * Ensures render state is fresh by calling update().
   * Returns a COPY of the cells to avoid pool reference issues.
   */
  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    // Call update() to ensure render state is fresh.
    // This is safe to call multiple times - dirty state persists until markClean().
    this.update();
    const viewport = this.getViewport();
    const start = y * this._cols;
    // Return deep copies to avoid cell pool reference issues
    return viewport.slice(start, start + this._cols).map((cell) => ({ ...cell }));
  }

  /** For compatibility with old API */
  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  /**
   * Check if a full redraw is needed (screen change, resize, etc.)
   * Note: This calls update() to ensure fresh state. Safe to call multiple times.
   */
  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  /** Mark render state as clean after rendering */
  clearDirty(): void {
    this.markClean();
  }

  // ==========================================================================
  // Terminal modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    return !!this.exports.ghostty_terminal_is_alternate_screen(this.handle);
  }

  hasBracketedPaste(): boolean {
    // Mode 2004 = bracketed paste (DEC mode)
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    // Mode 1004 = focus events (DEC mode)
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    return this.exports.ghostty_terminal_has_mouse_tracking(this.handle) !== 0;
  }

  // ==========================================================================
  // Extended API (scrollback, modes, etc.)
  // ==========================================================================

  /** Get dimensions - for compatibility */
  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  /** Get number of scrollback lines (history, not including active screen) */
  getScrollbackLength(): number {
    return this.exports.ghostty_terminal_get_scrollback_length(this.handle);
  }

  /**
   * Get a line from the scrollback buffer.
   * Ensures render state is fresh by calling update().
   * @param offset 0 = oldest line, (length-1) = most recent scrollback line
   */
  getScrollbackLine(offset: number): GhosttyCell[] | null {
    const neededSize = this._cols * CoderTerminal.CELL_SIZE;

    // Ensure buffer is allocated
    if (!this.viewportBufferPtr || this.viewportBufferSize < neededSize) {
      if (this.viewportBufferPtr) {
        this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      }
      this.viewportBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(neededSize);
      this.viewportBufferSize = neededSize;
    }

    // Call update() to ensure render state is fresh (needed for colors).
    // This is safe to call multiple times - dirty state persists until markClean().
    this.update();

    const count = this.exports.ghostty_terminal_get_scrollback_line(
      this.handle,
      offset,
      this.viewportBufferPtr,
      this._cols
    );

    if (count < 0) return null;

    // Parse cells
    const cells: GhosttyCell[] = [];
    const buffer = this.memory.buffer;
    const u8 = new Uint8Array(buffer, this.viewportBufferPtr, count * CoderTerminal.CELL_SIZE);
    const view = new DataView(buffer, this.viewportBufferPtr, count * CoderTerminal.CELL_SIZE);

    for (let i = 0; i < count; i++) {
      const cellOffset = i * CoderTerminal.CELL_SIZE;
      cells.push({
        codepoint: view.getUint32(cellOffset, true),
        fg_r: u8[cellOffset + 4],
        fg_g: u8[cellOffset + 5],
        fg_b: u8[cellOffset + 6],
        bg_r: u8[cellOffset + 7],
        bg_g: u8[cellOffset + 8],
        bg_b: u8[cellOffset + 9],
        flags: u8[cellOffset + 10],
        width: u8[cellOffset + 11],
        hyperlink_id: view.getUint16(cellOffset + 12, true),
        grapheme_len: u8[cellOffset + 14],
      });
    }

    return cells;
  }

  /** Check if a row in the active screen is wrapped (soft-wrapped to next line) */
  isRowWrapped(row: number): boolean {
    return this.exports.ghostty_terminal_is_row_wrapped(this.handle, row) !== 0;
  }

  /**
   * Get the hyperlink URI for a cell at the given position.
   * @param row Row index (0-based, in active viewport)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getHyperlinkUri(row: number, col: number): string | null {
    // Check if WASM has this function (requires rebuilt WASM with hyperlink support)
    if (!this.exports.ghostty_terminal_get_hyperlink_uri) {
      return null;
    }

    // Try with initial buffer, retry with larger if needed (for very long URLs)
    const bufferSizes = [2048, 8192, 32768];

    for (const bufSize of bufferSizes) {
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

      try {
        const bytesWritten = this.exports.ghostty_terminal_get_hyperlink_uri(
          this.handle,
          row,
          col,
          bufPtr,
          bufSize
        );

        // 0 means no hyperlink at this position
        if (bytesWritten === 0) return null;

        // -1 means buffer too small, try next size
        if (bytesWritten === -1) continue;

        // Negative values other than -1 are errors
        if (bytesWritten < 0) return null;

        const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesWritten);
        return new TextDecoder().decode(bytes.slice());
      } finally {
        this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      }
    }

    // URI too long even for largest buffer
    return null;
  }

  /**
   * Get the hyperlink URI for a cell in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest, scrollback_len-1 = newest)
   * @param col Column index (0-based)
   * @returns The URI string, or null if no hyperlink at that position
   */
  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    // Check if WASM has this function
    if (!this.exports.ghostty_terminal_get_scrollback_hyperlink_uri) {
      return null;
    }

    // Try with initial buffer, retry with larger if needed (for very long URLs)
    const bufferSizes = [2048, 8192, 32768];

    for (const bufSize of bufferSizes) {
      const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

      try {
        const bytesWritten = this.exports.ghostty_terminal_get_scrollback_hyperlink_uri(
          this.handle,
          offset,
          col,
          bufPtr,
          bufSize
        );

        // 0 means no hyperlink at this position
        if (bytesWritten === 0) return null;

        // -1 means buffer too small, try next size
        if (bytesWritten === -1) continue;

        // Negative values other than -1 are errors
        if (bytesWritten < 0) return null;

        const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesWritten);
        return new TextDecoder().decode(bytes.slice());
      } finally {
        this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      }
    }

    // URI too long even for largest buffer
    return null;
  }

  /**
   * Check if there are pending responses from the terminal.
   * Responses are generated by escape sequences like DSR (Device Status Report).
   */
  hasResponse(): boolean {
    return this.exports.ghostty_terminal_has_response(this.handle);
  }

  /**
   * Read pending responses from the terminal.
   * Returns the response string, or null if no responses pending.
   *
   * Responses are generated by escape sequences that require replies:
   * - DSR 6 (cursor position): Returns \x1b[row;colR
   * - DSR 5 (operating status): Returns \x1b[0n
   */
  readResponse(): string | null {
    if (!this.hasResponse()) return null;

    const bufSize = 256; // Most responses are small
    const bufPtr = this.exports.ghostty_wasm_alloc_u8_array(bufSize);

    try {
      const bytesRead = this.exports.ghostty_terminal_read_response(this.handle, bufPtr, bufSize);

      if (bytesRead <= 0) return null;

      const bytes = new Uint8Array(this.memory.buffer, bufPtr, bytesRead);
      return new TextDecoder().decode(bytes.slice());
    } finally {
      this.exports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
    }
  }

  /**
   * Query arbitrary terminal mode by number
   * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   */
  getMode(mode: number, isAnsi: boolean = false): boolean {
    return this.exports.ghostty_terminal_get_mode(this.handle, mode, isAnsi) !== 0;
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private initCellPool(): void {
    const total = this._cols * this._rows;
    if (this.cellPool.length < total) {
      for (let i = this.cellPool.length; i < total; i++) {
        this.cellPool.push({
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
        });
      }
    }
  }

  private parseCellsIntoPool(ptr: number, count: number): void {
    const buffer = this.memory.buffer;
    const u8 = new Uint8Array(buffer, ptr, count * CoderTerminal.CELL_SIZE);
    const view = new DataView(buffer, ptr, count * CoderTerminal.CELL_SIZE);

    for (let i = 0; i < count; i++) {
      const offset = i * CoderTerminal.CELL_SIZE;
      const cell = this.cellPool[i];
      cell.codepoint = view.getUint32(offset, true);
      cell.fg_r = u8[offset + 4];
      cell.fg_g = u8[offset + 5];
      cell.fg_b = u8[offset + 6];
      cell.bg_r = u8[offset + 7];
      cell.bg_g = u8[offset + 8];
      cell.bg_b = u8[offset + 9];
      cell.flags = u8[offset + 10];
      cell.width = u8[offset + 11];
      cell.hyperlink_id = view.getUint16(offset + 12, true);
      cell.grapheme_len = u8[offset + 14]; // grapheme_len is at byte 14
    }
  }

  /** Small buffer for grapheme lookups (reused to avoid allocation) */
  private graphemeBuffer: Uint32Array | null = null;
  private graphemeBufferPtr: number = 0;

  /**
   * Get all codepoints for a grapheme cluster at the given position.
   * For most cells this returns a single codepoint, but for complex scripts
   * (Hindi, emoji with ZWJ, etc.) it returns multiple codepoints.
   * @returns Array of codepoints, or null on error
   */
  getGrapheme(row: number, col: number): number[] | null {
    // Allocate buffer on first use (16 codepoints should be enough for any grapheme)
    if (!this.graphemeBuffer) {
      this.graphemeBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(16 * 4);
      this.graphemeBuffer = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, 16);
    }

    const count = this.exports.ghostty_render_state_get_grapheme(
      this.handle,
      row,
      col,
      this.graphemeBufferPtr,
      16
    );

    if (count < 0) return null;

    // Re-create view in case memory grew
    const view = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, count);
    return Array.from(view);
  }

  /**
   * Get a string representation of the grapheme at the given position.
   * This properly handles complex scripts like Hindi, emoji with ZWJ, etc.
   */
  getGraphemeString(row: number, col: number): string {
    const codepoints = this.getGrapheme(row, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  /**
   * Get all codepoints for a grapheme cluster in the scrollback buffer.
   * @param offset Scrollback line offset (0 = oldest)
   * @param col Column index
   * @returns Array of codepoints, or null on error
   */
  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    // Reuse the same buffer as getGrapheme
    if (!this.graphemeBuffer) {
      this.graphemeBufferPtr = this.exports.ghostty_wasm_alloc_u8_array(16 * 4);
      this.graphemeBuffer = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, 16);
    }

    const count = this.exports.ghostty_terminal_get_scrollback_grapheme(
      this.handle,
      offset,
      col,
      this.graphemeBufferPtr,
      16
    );

    if (count < 0) return null;

    // Re-create view in case memory grew
    const view = new Uint32Array(this.memory.buffer, this.graphemeBufferPtr, count);
    return Array.from(view);
  }

  /**
   * Get a string representation of a grapheme in the scrollback buffer.
   */
  getScrollbackGraphemeString(offset: number, col: number): string {
    const codepoints = this.getScrollbackGrapheme(offset, col);
    if (!codepoints || codepoints.length === 0) return ' ';
    return String.fromCodePoint(...codepoints);
  }

  private invalidateBuffers(): void {
    if (this.viewportBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.viewportBufferPtr, this.viewportBufferSize);
      this.viewportBufferPtr = 0;
      this.viewportBufferSize = 0;
    }
    if (this.graphemeBufferPtr) {
      this.exports.ghostty_wasm_free_u8_array(this.graphemeBufferPtr, 16 * 4);
      this.graphemeBufferPtr = 0;
    }
    this.graphemeBuffer = null;
  }
}

// ============================================================================
// Official libghostty-vt engine (ADR 042)
// ============================================================================
//
// Rules (ADR 041):
// - Struct offsets, enum values and the packed GhosttyCell bit positions come from
//   the wasm's own `ghostty_type_json` manifest at load. A missing name throws, so a
//   pin bump that renames or moves a field fails loudly instead of misreading memory.
//   The one hard-coded encoding is GhosttyMode (`modes.h` `ghostty_mode_new`: the
//   mode number in bits 0-14, bit 15 set for ANSI modes), which the manifest only
//   records as a u16.
// - No view of wasm memory outlives an export call: memory growth detaches the
//   ArrayBuffer. Views are rebuilt after every call (`u8()`, `dv()`), CELLS_RAW rows
//   are copied into a JS-owned array before anything else is called, and callbacks
//   copy their payload before returning.
// - Callbacks never re-enter `vt_write`.

/** Exports of the official wasm the binding calls (pointers, handles, size_t: i32). */
interface OfficialWasmExports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_free_opaque(ptr: number): void;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_terminal_new(allocator: number, out: number, cols: number, rows: number): number;
  ghostty_terminal_free(term: number): void;
  ghostty_terminal_resize(
    term: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ): number;
  ghostty_terminal_set(term: number, option: number, value: number): number;
  ghostty_terminal_get(term: number, data: number, out: number): number;
  ghostty_terminal_get_multi(
    term: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number
  ): number;
  ghostty_terminal_vt_write(term: number, ptr: number, len: number): void;
  /** The GhosttyTerminalScrollViewport struct is passed by value, i.e. by pointer on wasm32. */
  ghostty_terminal_scroll_viewport(term: number, behavior: number): void;
  /** The GhosttyPoint struct is passed by value, i.e. by pointer on wasm32. */
  ghostty_terminal_grid_ref(term: number, point: number, outRef: number): number;
  ghostty_grid_ref_row(ref: number, outRow: number): number;
  ghostty_grid_ref_hyperlink_uri(ref: number, buf: number, len: number, outLen: number): number;
  /** GhosttyRow is a u64 passed by value (a BigInt on the JS side). */
  ghostty_row_get(row: bigint, data: number, out: number): number;
  ghostty_render_state_new(allocator: number, out: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, term: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_get(state: number, data: number, out: number): number;
  ghostty_render_state_get_multi(
    state: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number
  ): number;
  ghostty_render_state_row_iterator_new(allocator: number, out: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_iterator_next(iterator: number): number;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): number;
  ghostty_render_state_row_get_multi(
    iterator: number,
    count: number,
    keys: number,
    values: number,
    outWritten: number
  ): number;
  ghostty_render_state_row_cells_new(allocator: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, data: number, out: number): number;
  ghostty_key_encoder_new(allocator: number, out: number): number;
  ghostty_key_encoder_free(encoder: number): void;
  ghostty_key_encoder_setopt(encoder: number, option: number, value: number): void;
  ghostty_key_encoder_encode(
    encoder: number,
    event: number,
    buf: number,
    len: number,
    outLen: number
  ): number;
  ghostty_key_event_new(allocator: number, out: number): number;
  ghostty_key_event_free(event: number): void;
  ghostty_key_event_set_action(event: number, action: number): void;
  ghostty_key_event_set_key(event: number, key: number): void;
  ghostty_key_event_set_mods(event: number, mods: number): void;
  ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
}

interface ManifestBits {
  lsb: number;
  width: number;
  arms?: Record<string, { bits: Record<string, ManifestBits> } | null>;
}

interface ManifestType {
  kind: string;
  size: number;
  fields?: Record<string, { offset: number; size: number }>;
  values?: Record<string, number>;
  bits?: Record<string, ManifestBits>;
}

/** A bit field of a packed value: shift right by `lsb`, then mask. */
interface BitField {
  lsb: number;
  mask: number;
}

/** Reads the bits at `lsb` (masked) from a 64-bit value split into two u32 words. */
function readBits(lo: number, hi: number, lsb: number, mask: number): number {
  if (lsb >= 32) return (hi >>> (lsb - 32)) & mask;
  if (lsb === 0) return lo & mask;
  return ((lo >>> lsb) | (hi << (32 - lsb))) & mask;
}

/** Struct layouts and enum values from the wasm's `ghostty_type_json` manifest. */
class VtLayout {
  private readonly types: Record<string, ManifestType>;

  constructor(types: Record<string, ManifestType>) {
    this.types = types;
  }

  type(name: string): ManifestType {
    const t = this.types[name];
    if (!t) throw new Error(`libghostty-vt manifest has no type ${name}`);
    return t;
  }

  size(name: string): number {
    return this.type(name).size;
  }

  offset(type: string, field: string): number {
    const f = this.type(type).fields?.[field];
    if (!f) throw new Error(`libghostty-vt manifest has no field ${type}.${field}`);
    return f.offset;
  }

  enums(name: string): Record<string, number> {
    const values = this.type(name).values;
    if (!values) throw new Error(`libghostty-vt manifest type ${name} is not an enum`);
    return values;
  }

  value(name: string, key: string): number {
    const v = this.enums(name)[key];
    if (v === undefined) throw new Error(`libghostty-vt manifest has no value ${name}.${key}`);
    return v;
  }

  bitField(bits: Record<string, ManifestBits> | undefined, path: string): BitField {
    const b = bits?.[path];
    if (!b) throw new Error(`libghostty-vt manifest has no bit field ${path}`);
    return { lsb: b.lsb, mask: b.width >= 32 ? 0xffffffff : 2 ** b.width - 1 };
  }

  /** The bits of one arm of a packed union field, e.g. GhosttyCell.content.CODEPOINT. */
  armBits(type: string, field: string, arm: string): Record<string, ManifestBits> {
    const a = this.type(type).bits?.[field]?.arms?.[arm];
    if (!a) throw new Error(`libghostty-vt manifest has no arm ${type}.${field}.${arm}`);
    return a.bits;
  }
}

/**
 * Ghostty's key names for the ghostty-web `Key` names that differ (ADR 042). Every
 * other `Key` keeps its name; values are always translated by name because 29 keys
 * have different numbers in the two builds.
 */
const OFFICIAL_KEY_NAMES: Readonly<Record<string, string>> = {
  GRAVE: 'BACKQUOTE',
  ZERO: 'DIGIT_0',
  ONE: 'DIGIT_1',
  TWO: 'DIGIT_2',
  THREE: 'DIGIT_3',
  FOUR: 'DIGIT_4',
  FIVE: 'DIGIT_5',
  SIX: 'DIGIT_6',
  SEVEN: 'DIGIT_7',
  EIGHT: 'DIGIT_8',
  NINE: 'DIGIT_9',
  UP: 'ARROW_UP',
  DOWN: 'ARROW_DOWN',
  LEFT: 'ARROW_LEFT',
  RIGHT: 'ARROW_RIGHT',
  KP_0: 'NUMPAD_0',
  KP_1: 'NUMPAD_1',
  KP_2: 'NUMPAD_2',
  KP_3: 'NUMPAD_3',
  KP_4: 'NUMPAD_4',
  KP_5: 'NUMPAD_5',
  KP_6: 'NUMPAD_6',
  KP_7: 'NUMPAD_7',
  KP_8: 'NUMPAD_8',
  KP_9: 'NUMPAD_9',
  KP_PLUS: 'NUMPAD_ADD',
  KP_BACKSPACE: 'NUMPAD_BACKSPACE',
  KP_CLEAR: 'NUMPAD_CLEAR',
  KP_CLEAR_ENTRY: 'NUMPAD_CLEAR_ENTRY',
  KP_COMMA: 'NUMPAD_COMMA',
  KP_PERIOD: 'NUMPAD_DECIMAL',
  KP_DIVIDE: 'NUMPAD_DIVIDE',
  KP_ENTER: 'NUMPAD_ENTER',
  KP_EQUAL: 'NUMPAD_EQUAL',
  KP_MEMORY_ADD: 'NUMPAD_MEMORY_ADD',
  KP_MEMORY_CLEAR: 'NUMPAD_MEMORY_CLEAR',
  KP_MEMORY_RECALL: 'NUMPAD_MEMORY_RECALL',
  KP_MEMORY_STORE: 'NUMPAD_MEMORY_STORE',
  KP_MEMORY_SUBTRACT: 'NUMPAD_MEMORY_SUBTRACT',
  KP_MULTIPLY: 'NUMPAD_MULTIPLY',
  KP_PAREN_LEFT: 'NUMPAD_PAREN_LEFT',
  KP_PAREN_RIGHT: 'NUMPAD_PAREN_RIGHT',
  KP_MINUS: 'NUMPAD_SUBTRACT',
  KP_SEPARATOR: 'NUMPAD_SEPARATOR',
};

/** Ghostty's key encoder option names for the ghostty-web names that differ. */
const OFFICIAL_ENCODER_OPTION_NAMES: Readonly<Record<string, string>> = {
  KITTY_KEYBOARD_FLAGS: 'KITTY_FLAGS',
};

/** Maps a numeric TS enum's values to the official enum's values, by name. */
function translateEnum(
  ours: Record<string, string | number>,
  layout: VtLayout,
  official: string,
  renames: Readonly<Record<string, string>>
): Map<number, number> {
  const map = new Map<number, number>();
  for (const [name, value] of Object.entries(ours)) {
    if (typeof value !== 'number') continue;
    map.set(value, layout.value(official, renames[name] ?? name));
  }
  return map;
}

/** Enum values, offsets and bit fields the official binding uses, resolved once per instance. */
function resolveOfficialLayout(layout: VtLayout) {
  const opt = (k: string) => layout.value('GhosttyTerminalOption', k);
  const tdata = (k: string) => layout.value('GhosttyTerminalData', k);
  const cellBits = layout.type('GhosttyCell').bits;
  const cp = layout.armBits('GhosttyCell', 'content', 'CODEPOINT');
  const cpg = layout.armBits('GhosttyCell', 'content', 'CODEPOINT_GRAPHEME');
  const pal = layout.armBits('GhosttyCell', 'content', 'BG_COLOR_PALETTE');
  const rgb = layout.armBits('GhosttyCell', 'content', 'BG_COLOR_RGB');
  const codepoint = layout.bitField(cp, 'codepoint');
  const graphemeCodepoint = layout.bitField(cpg, 'codepoint');
  if (codepoint.lsb !== graphemeCodepoint.lsb || codepoint.mask !== graphemeCodepoint.mask) {
    throw new Error('libghostty-vt GhosttyCell codepoint arms differ');
  }
  return {
    opt: {
      WRITE_PTY: opt('WRITE_PTY'),
      BELL: opt('BELL'),
      TITLE_CHANGED: opt('TITLE_CHANGED'),
      SIZE: opt('SIZE'),
      DEVICE_ATTRIBUTES: opt('DEVICE_ATTRIBUTES'),
      COLOR_FOREGROUND: opt('COLOR_FOREGROUND'),
      COLOR_BACKGROUND: opt('COLOR_BACKGROUND'),
      COLOR_CURSOR: opt('COLOR_CURSOR'),
      COLOR_PALETTE: opt('COLOR_PALETTE'),
      SCROLLBACK_MAX_BYTES: opt('SCROLLBACK_MAX_BYTES'),
      MODE_DEFAULT: opt('MODE_DEFAULT'),
    },
    tdata: {
      CURSOR_X: tdata('CURSOR_X'),
      CURSOR_Y: tdata('CURSOR_Y'),
      ACTIVE_SCREEN: tdata('ACTIVE_SCREEN'),
      MOUSE_TRACKING: tdata('MOUSE_TRACKING'),
      TITLE: tdata('TITLE'),
      SCROLLBACK_ROWS: tdata('SCROLLBACK_ROWS'),
      COLOR_PALETTE_DEFAULT: tdata('COLOR_PALETTE_DEFAULT'),
      MODE: tdata('MODE'),
    },
    screenAlternate: layout.value('GhosttyTerminalScreen', 'ALTERNATE'),
    rs: {
      DIRTY: layout.value('GhosttyRenderStateData', 'DIRTY'),
      ROW_ITERATOR: layout.value('GhosttyRenderStateData', 'ROW_ITERATOR'),
      CURSOR: layout.value('GhosttyRenderStateData', 'CURSOR'),
      COLORS: layout.value('GhosttyRenderStateData', 'COLORS'),
    },
    dirty: {
      FALSE: layout.value('GhosttyRenderStateDirty', 'FALSE'),
      PARTIAL: layout.value('GhosttyRenderStateDirty', 'PARTIAL'),
      FULL: layout.value('GhosttyRenderStateDirty', 'FULL'),
    },
    row: {
      CELLS: layout.value('GhosttyRenderStateRowData', 'CELLS'),
      CELLS_RAW: layout.value('GhosttyRenderStateRowData', 'CELLS_RAW'),
      VIEWPORT_Y: layout.value('GhosttyRenderStateRowData', 'VIEWPORT_Y'),
    },
    cellData: {
      STYLE: layout.value('GhosttyRenderStateRowCellsData', 'STYLE'),
      GRAPHEMES_LEN: layout.value('GhosttyRenderStateRowCellsData', 'GRAPHEMES_LEN'),
      GRAPHEMES_BUF: layout.value('GhosttyRenderStateRowCellsData', 'GRAPHEMES_BUF'),
    },
    rowWrapContinuation: layout.value('GhosttyRowData', 'WRAP_CONTINUATION'),
    cell: {
      tag: layout.bitField(cellBits, 'content_tag'),
      content: layout.bitField(cellBits, 'content'),
      style: layout.bitField(cellBits, 'style_id'),
      wide: layout.bitField(cellBits, 'wide'),
      hyperlink: layout.bitField(cellBits, 'hyperlink'),
      codepoint,
      paletteIndex: layout.bitField(pal, 'index'),
      r: layout.bitField(rgb, 'r'),
      g: layout.bitField(rgb, 'g'),
      b: layout.bitField(rgb, 'b'),
    },
    tag: {
      CODEPOINT: layout.value('GhosttyCellContentTag', 'CODEPOINT'),
      CODEPOINT_GRAPHEME: layout.value('GhosttyCellContentTag', 'CODEPOINT_GRAPHEME'),
      BG_COLOR_PALETTE: layout.value('GhosttyCellContentTag', 'BG_COLOR_PALETTE'),
      BG_COLOR_RGB: layout.value('GhosttyCellContentTag', 'BG_COLOR_RGB'),
    },
    wide: {
      NARROW: layout.value('GhosttyCellWide', 'NARROW'),
      WIDE: layout.value('GhosttyCellWide', 'WIDE'),
    },
    styleColor: {
      NONE: layout.value('GhosttyStyleColorTag', 'NONE'),
      PALETTE: layout.value('GhosttyStyleColorTag', 'PALETTE'),
      RGB: layout.value('GhosttyStyleColorTag', 'RGB'),
      tag: layout.offset('GhosttyStyleColor', 'tag'),
      value: layout.offset('GhosttyStyleColor', 'value'),
      palette: layout.offset('GhosttyStyleColorValue', 'palette'),
      rgb: layout.offset('GhosttyStyleColorValue', 'rgb'),
    },
    style: {
      size: layout.size('GhosttyStyle'),
      sizeField: layout.offset('GhosttyStyle', 'size'),
      fg: layout.offset('GhosttyStyle', 'fg_color'),
      bg: layout.offset('GhosttyStyle', 'bg_color'),
      bold: layout.offset('GhosttyStyle', 'bold'),
      italic: layout.offset('GhosttyStyle', 'italic'),
      faint: layout.offset('GhosttyStyle', 'faint'),
      blink: layout.offset('GhosttyStyle', 'blink'),
      inverse: layout.offset('GhosttyStyle', 'inverse'),
      invisible: layout.offset('GhosttyStyle', 'invisible'),
      strikethrough: layout.offset('GhosttyStyle', 'strikethrough'),
      underline: layout.offset('GhosttyStyle', 'underline'),
    },
    cursor: {
      size: layout.size('GhosttyRenderStateCursor'),
      sizeField: layout.offset('GhosttyRenderStateCursor', 'size'),
      visible: layout.offset('GhosttyRenderStateCursor', 'visible'),
      blinking: layout.offset('GhosttyRenderStateCursor', 'blinking'),
      visualStyle: layout.offset('GhosttyRenderStateCursor', 'visual_style'),
    },
    cursorStyle: {
      BAR: layout.value('GhosttyRenderStateCursorVisualStyle', 'BAR'),
      BLOCK: layout.value('GhosttyRenderStateCursorVisualStyle', 'BLOCK'),
      UNDERLINE: layout.value('GhosttyRenderStateCursorVisualStyle', 'UNDERLINE'),
    },
    colors: {
      size: layout.size('GhosttyRenderStateColors'),
      sizeField: layout.offset('GhosttyRenderStateColors', 'size'),
      background: layout.offset('GhosttyRenderStateColors', 'background'),
      foreground: layout.offset('GhosttyRenderStateColors', 'foreground'),
      cursor: layout.offset('GhosttyRenderStateColors', 'cursor'),
      cursorHasValue: layout.offset('GhosttyRenderStateColors', 'cursor_has_value'),
      palette: layout.offset('GhosttyRenderStateColors', 'palette'),
      rgbSize: layout.size('GhosttyColorRgb'),
      r: layout.offset('GhosttyColorRgb', 'r'),
      g: layout.offset('GhosttyColorRgb', 'g'),
      b: layout.offset('GhosttyColorRgb', 'b'),
    },
    cellsView: {
      size: layout.size('GhosttyCellsView'),
      ptr: layout.offset('GhosttyCellsView', 'ptr'),
      len: layout.offset('GhosttyCellsView', 'len'),
    },
    cellSize: layout.size('GhosttyCell'),
    scroll: {
      size: layout.size('GhosttyTerminalScrollViewport'),
      tag: layout.offset('GhosttyTerminalScrollViewport', 'tag'),
      value: layout.offset('GhosttyTerminalScrollViewport', 'value'),
      BOTTOM: layout.value('GhosttyTerminalScrollViewportTag', 'BOTTOM'),
      ROW: layout.value('GhosttyTerminalScrollViewportTag', 'ROW'),
    },
    point: {
      size: layout.size('GhosttyPoint'),
      tag: layout.offset('GhosttyPoint', 'tag'),
      value: layout.offset('GhosttyPoint', 'value'),
      x: layout.offset('GhosttyPointCoordinate', 'x'),
      y: layout.offset('GhosttyPointCoordinate', 'y'),
      ACTIVE: layout.value('GhosttyPointTag', 'ACTIVE'),
      HISTORY: layout.value('GhosttyPointTag', 'HISTORY'),
    },
    gridRef: {
      size: layout.size('GhosttyGridRef'),
      sizeField: layout.offset('GhosttyGridRef', 'size'),
    },
    string: {
      size: layout.size('GhosttyString'),
      ptr: layout.offset('GhosttyString', 'ptr'),
      len: layout.offset('GhosttyString', 'len'),
    },
    mode: {
      size: layout.size('GhosttyTerminalModeConfig'),
      mode: layout.offset('GhosttyTerminalModeConfig', 'mode'),
      value: layout.offset('GhosttyTerminalModeConfig', 'value'),
    },
    sizeReport: {
      rows: layout.offset('GhosttySizeReportSize', 'rows'),
      columns: layout.offset('GhosttySizeReportSize', 'columns'),
      cellWidth: layout.offset('GhosttySizeReportSize', 'cell_width'),
      cellHeight: layout.offset('GhosttySizeReportSize', 'cell_height'),
    },
    da: {
      primary: layout.offset('GhosttyDeviceAttributes', 'primary'),
      secondary: layout.offset('GhosttyDeviceAttributes', 'secondary'),
      tertiary: layout.offset('GhosttyDeviceAttributes', 'tertiary'),
      conformance: layout.offset('GhosttyDeviceAttributesPrimary', 'conformance_level'),
      features: layout.offset('GhosttyDeviceAttributesPrimary', 'features'),
      numFeatures: layout.offset('GhosttyDeviceAttributesPrimary', 'num_features'),
      deviceType: layout.offset('GhosttyDeviceAttributesSecondary', 'device_type'),
      firmware: layout.offset('GhosttyDeviceAttributesSecondary', 'firmware_version'),
      rom: layout.offset('GhosttyDeviceAttributesSecondary', 'rom_cartridge'),
      unitId: layout.offset('GhosttyDeviceAttributesTertiary', 'unit_id'),
    },
    result: {
      SUCCESS: layout.value('GhosttyResult', 'SUCCESS'),
      OUT_OF_SPACE: layout.value('GhosttyResult', 'OUT_OF_SPACE'),
    },
  };
}

type OfficialLayout = ReturnType<typeof resolveOfficialLayout>;

/**
 * The official engine: Ghostty's unpatched libghostty-vt wasm (ADR 041, ADR 042).
 */
export class OfficialGhostty extends Ghostty {
  readonly engine = 'official' as const;
  /** @internal The wasm exports; only this file calls them. */
  readonly ex: OfficialWasmExports;
  /** @internal */
  readonly L: OfficialLayout;
  /** @internal One function table per instance; terminals install their callbacks in it. */
  readonly fnTable: FnTable;
  /** @internal ghostty-web `Key` value → official `GhosttyKey` value. */
  readonly keys: Map<number, number>;
  /** @internal ghostty-web `KeyEncoderOption` → official `GhosttyKeyEncoderOption`. */
  readonly encoderOptions: Map<number, number>;
  /** @internal ghostty-web `KeyAction` → official `GhosttyKeyAction`. */
  readonly keyActions: Map<number, number>;
  /** @internal */
  readonly unidentifiedKey: number;
  /** The library's manifest header: library version and build commit. */
  readonly libraryVersion: string;

  constructor(exports: OfficialWasmExports) {
    super();
    this.ex = exports;
    const p = exports.ghostty_type_json();
    const u8 = new Uint8Array(exports.memory.buffer);
    let end = p;
    while (u8[end] !== 0) end++;
    const manifest = JSON.parse(new TextDecoder().decode(u8.subarray(p, end))) as {
      library_version?: string;
      types: Record<string, ManifestType>;
    };
    const layout = new VtLayout(manifest.types);
    this.L = resolveOfficialLayout(layout);
    this.libraryVersion = manifest.library_version ?? '';
    this.fnTable = new FnTable(exports.__indirect_function_table);
    this.keys = translateEnum(Key, layout, 'GhosttyKey', OFFICIAL_KEY_NAMES);
    this.encoderOptions = translateEnum(
      KeyEncoderOption,
      layout,
      'GhosttyKeyEncoderOption',
      OFFICIAL_ENCODER_OPTION_NAMES
    );
    this.keyActions = translateEnum(KeyAction, layout, 'GhosttyKeyAction', {});
    this.unidentifiedKey = layout.value('GhosttyKey', 'UNIDENTIFIED');
  }

  createKeyEncoder(): KeyEncoder {
    return new OfficialKeyEncoder(this);
  }

  createTerminal(
    cols: number = 80,
    rows: number = 24,
    config?: GhosttyTerminalConfig
  ): OfficialTerminal {
    return new OfficialTerminal(this, cols, rows, config);
  }

  /** @internal Creates an object through a `GhosttyFoo* out` slot and returns its handle. */
  newHandle(what: string, create: (slot: number) => number): number {
    const ex = this.ex;
    const slot = ex.ghostty_wasm_alloc_opaque();
    try {
      const rc = create(slot);
      if (rc !== 0) throw new Error(`libghostty-vt ${what} failed: ${rc}`);
      return ex.ghostty_wasm_take_opaque(slot);
    } finally {
      ex.ghostty_wasm_free_opaque(slot);
    }
  }
}

/** Scratch memory: one wasm allocation carved into aligned, named slots. */
class Scratch {
  readonly base: number;
  readonly len: number;
  private readonly ex: OfficialWasmExports;

  private constructor(ex: OfficialWasmExports, base: number, len: number) {
    this.ex = ex;
    this.base = base;
    this.len = len;
  }

  /** Allocates the slots; each value is [size, align]. Returns the slot addresses. */
  static create<K extends string>(
    ex: OfficialWasmExports,
    slots: Record<K, readonly [number, number]>
  ): { scratch: Scratch; at: Record<K, number> } {
    let off = 0;
    const offsets = {} as Record<K, number>;
    for (const key of Object.keys(slots) as K[]) {
      const [size, align] = slots[key];
      off = Math.ceil(off / align) * align;
      offsets[key] = off;
      off += size;
    }
    const len = off + 8;
    const raw = ex.ghostty_wasm_alloc(len);
    if (!raw) throw new Error('libghostty-vt: out of memory');
    const base = Math.ceil(raw / 8) * 8;
    const at = {} as Record<K, number>;
    for (const key of Object.keys(offsets) as K[]) at[key] = base + offsets[key];
    return { scratch: new Scratch(ex, raw, len), at };
  }

  free(): void {
    this.ex.ghostty_wasm_free(this.base, this.len);
  }
}

/** A decoded row: JS-owned cells and the strings of its multi-codepoint graphemes. */
interface RowRef {
  cells: GhosttyCell[];
  /** Index of the row's first cell in `cells`. */
  base: number;
  /** Column → grapheme string, for cells holding more than one codepoint. */
  graphemes: Map<number, string> | null;
}

interface DecodedStyle {
  /** 0xRRGGBB, or -1 for the default. */
  fg: number;
  bg: number;
  flags: number;
}

const I32 = WasmValType.I32;
/** At most this many pages of scrollback rows stay cached per generation. */
const PAGE_CACHE_SIZE = 16;
/** `scrollback: 0` (unlimited on the Coder wasm) becomes this byte ceiling. */
const UNLIMITED_SCROLLBACK_BYTES = 32 * 1024 * 1024;
/** The Coder engine's default scrollback limit when no config is given. */
const DEFAULT_SCROLLBACK_BYTES = 10000;
/** The Coder engine's default colours, used when the theme leaves one unset. */
const FALLBACK_FOREGROUND = 0xcccccc;
const FALLBACK_BACKGROUND = 0x000000;
/** Grapheme codepoints read through the scratch buffer; longer clusters allocate. */
const GRAPHEME_SCRATCH = 32;

function blankCell(): GhosttyCell {
  return {
    codepoint: 0,
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

function setRgb(cell: GhosttyCell, fg: number, bg: number): void {
  cell.fg_r = (fg >>> 16) & 0xff;
  cell.fg_g = (fg >>> 8) & 0xff;
  cell.fg_b = fg & 0xff;
  cell.bg_r = (bg >>> 16) & 0xff;
  cell.bg_g = (bg >>> 8) & 0xff;
  cell.bg_b = bg & 0xff;
}

function rgbObject(rgb: number): RGB {
  return { r: (rgb >>> 16) & 0xff, g: (rgb >>> 8) & 0xff, b: rgb & 0xff };
}

/**
 * Whether one `WRITE_PTY` reply is the kitty keyboard query reply `ESC [ ? <flags> u`
 * (`queryKittyKeyboard` in Ghostty's `stream_terminal.zig`). No other reply has
 * this shape: DECRQM ends in `$y`, DA in `c`.
 */
function isKittyKeyboardReply(reply: Uint8Array): boolean {
  const n = reply.length;
  if (n < 5 || reply[0] !== 0x1b || reply[1] !== 0x5b || reply[2] !== 0x3f) return false;
  if (reply[n - 1] !== 0x75) return false;
  for (let i = 3; i < n - 1; i++) {
    if (reply[i] < 0x30 || reply[i] > 0x39) return false;
  }
  return true;
}

/**
 * A terminal on the official libghostty-vt wasm (ADR 042).
 *
 * Rows are read through the render state: a refresh runs `render_state_update`,
 * visits the dirty rows with `row_iterator_next_dirty`, and decodes each row's
 * `CELLS_RAW` into JS-owned cells indexed by active row. Refreshes happen only
 * when the generation (bumped by writes, resizes and pixel-size changes) has
 * changed, so the many `update()` calls of one frame decode each row once.
 * Ghostty's viewport stays at the bottom, so the primary copy is the active
 * screen. Scrollback rows are read a page at a time through a second render
 * state and cached until the content changes, so scrolling only records the
 * offset and serves rows from the copy and the cache.
 */
export class OfficialTerminal implements GhosttyTerminal {
  readonly answersSizeQueries = true;

  private readonly vt: OfficialGhostty;
  private readonly ex: OfficialWasmExports;
  private readonly L: OfficialLayout;
  private term = 0;
  private rs = 0;
  private iter = 0;
  private rowCells = 0;
  private pageRs = 0;
  private readonly scratch: Scratch;
  private readonly at: Record<
    | 'iterH'
    | 'cellsH'
    | 'y'
    | 'dirty'
    | 'viewY'
    | 'view'
    | 'cursor'
    | 'colors'
    | 'style'
    | 'rsKeys'
    | 'rsVals'
    | 'rowKeys'
    | 'rowVals'
    | 'tKeys'
    | 'tVals'
    | 'curX'
    | 'curY'
    | 'sbRows'
    | 'screen'
    | 'scroll'
    | 'point'
    | 'gridRef'
    | 'row64'
    | 'str'
    | 'mode'
    | 'u32'
    | 'u8'
    | 'gBuf'
    | 'palette',
    number
  >;
  private readonly callbacks: InstalledFn[] = [];
  private _cols: number;
  private _rows: number;
  private cellWidthPx = 0;
  private cellHeightPx = 0;

  // Generation and refresh state. The generation is bumped by every content change
  // (scrolling is not one) and also keys the page cache.
  private generation = 1;
  private refreshedGen = 0;
  private infoGen = 0;
  private decodeAll = true;
  private readonly dirtyRows = new Set<number>();
  private dirtyMax: DirtyState = DirtyState.NONE;

  // The JS copy of the active screen, indexed by active row.
  private viewCells: GhosttyCell[] = [];
  private viewGraphemes: (Map<number, string> | null)[] = [];
  private raw = new Uint32Array(0);
  private readonly rowStyles = new Map<number, DecodedStyle>();

  // Terminal info, read once per generation.
  private cursorX = 0;
  private cursorY = 0;
  private sbRows = 0;
  private altScreen = false;

  // Render-state cursor and colours from the last refresh.
  private cursorVisible = true;
  private cursorBlinking = false;
  private cursorStyle: RenderStateCursor['style'] = 'block';
  private defFg = 0xffffff;
  private defBg = 0;
  private cursorColor: number | null = null;
  private readonly palette = new Uint8Array(256 * 3);

  // The view's offset: lines scrolled up from the bottom. Ghostty's viewport stays at
  // the bottom; only page reads move it, and they move it back.
  private offset = 0;

  // Scrollback rows, keyed by the absolute row their page starts at.
  private readonly pages = new Map<number, RowRef[]>();
  private pageGen = 0;

  // Effects.
  private readonly responses: Uint8Array[] = [];
  private bell = false;
  private titleChanged = false;
  private pendingTitle: string | null = null;

  constructor(vt: OfficialGhostty, cols: number, rows: number, config?: GhosttyTerminalConfig) {
    this.vt = vt;
    this.ex = vt.ex;
    this.L = vt.L;
    this._cols = cols;
    this._rows = rows;
    const ex = this.ex;
    const L = this.L;

    this.term = vt.newHandle('terminal_new', (slot) => ex.ghostty_terminal_new(0, slot, cols, rows));
    this.rs = vt.newHandle('render_state_new', (slot) => ex.ghostty_render_state_new(0, slot));
    this.iter = vt.newHandle('row_iterator_new', (slot) =>
      ex.ghostty_render_state_row_iterator_new(0, slot)
    );
    this.rowCells = vt.newHandle('row_cells_new', (slot) =>
      ex.ghostty_render_state_row_cells_new(0, slot)
    );

    const { scratch, at } = Scratch.create(ex, {
      iterH: [4, 4],
      cellsH: [4, 4],
      y: [4, 4],
      dirty: [4, 4],
      viewY: [4, 4],
      view: [L.cellsView.size, 8],
      cursor: [L.cursor.size, 8],
      colors: [L.colors.size, 8],
      style: [L.style.size, 8],
      rsKeys: [12, 4],
      rsVals: [12, 4],
      rowKeys: [12, 4],
      rowVals: [12, 4],
      tKeys: [16, 4],
      tVals: [16, 4],
      curX: [4, 4],
      curY: [4, 4],
      sbRows: [4, 4],
      screen: [4, 4],
      scroll: [L.scroll.size, 8],
      point: [L.point.size, 8],
      gridRef: [L.gridRef.size, 8],
      row64: [8, 8],
      str: [L.string.size, 8],
      mode: [L.mode.size, 8],
      u32: [8, 8],
      u8: [8, 8],
      gBuf: [GRAPHEME_SCRATCH * 4, 8],
      palette: [256 * L.colors.rgbSize, 8],
    } as const);
    this.scratch = scratch;
    this.at = at;

    // Fixed scratch contents: handle slots and the key/value arrays of the multi-gets.
    const dv = this.dv();
    dv.setUint32(at.iterH, this.iter, true);
    dv.setUint32(at.cellsH, this.rowCells, true);
    this.setU32s(at.rsKeys, [L.rs.DIRTY, L.rs.CURSOR, L.rs.COLORS]);
    this.setU32s(at.rsVals, [at.dirty, at.cursor, at.colors]);
    this.setU32s(at.rowKeys, [L.row.CELLS_RAW, L.row.VIEWPORT_Y, L.row.CELLS]);
    this.setU32s(at.rowVals, [at.view, at.viewY, at.cellsH]);
    this.setU32s(at.tKeys, [
      L.tdata.CURSOR_X,
      L.tdata.CURSOR_Y,
      L.tdata.SCROLLBACK_ROWS,
      L.tdata.ACTIVE_SCREEN,
    ]);
    this.setU32s(at.tVals, [at.curX, at.curY, at.sbRows, at.screen]);

    this.installCallbacks();
    this.applyConfig(config);
    this.allocView();
  }

  get cols(): number {
    return this._cols;
  }

  get rows(): number {
    return this._rows;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    // Writes never leave the view scrolled (terminal.ts scrolls to the bottom after
    // writing); the first frame at the bottom repaints every row.
    if (this.offset !== 0) {
      this.offset = 0;
      this.dirtyMax = DirtyState.FULL;
    }
    if (bytes.length > 0) {
      const ex = this.ex;
      const ptr = ex.ghostty_wasm_alloc(bytes.length);
      if (!ptr) throw new Error('libghostty-vt: out of memory');
      this.u8().set(bytes, ptr);
      ex.ghostty_terminal_vt_write(this.term, ptr, bytes.length);
      ex.ghostty_wasm_free(ptr, bytes.length);
    }
    this.generation++;
    if (this.titleChanged) this.readTitle();
  }

  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): void {
    if (cols === this._cols && rows === this._rows) {
      if (cellWidthPx !== undefined && cellHeightPx !== undefined) {
        this.setCellPixelSize(cellWidthPx, cellHeightPx);
      }
      return;
    }
    this._cols = cols;
    this._rows = rows;
    if (cellWidthPx !== undefined && cellHeightPx !== undefined) {
      this.cellWidthPx = Math.max(0, Math.round(cellWidthPx));
      this.cellHeightPx = Math.max(0, Math.round(cellHeightPx));
    }
    // One call per real change: with mode 2048 on, every call sends a size report.
    const rc = this.ex.ghostty_terminal_resize(
      this.term,
      cols,
      rows,
      this.cellWidthPx,
      this.cellHeightPx
    );
    if (rc !== 0) throw new Error(`libghostty-vt terminal_resize failed: ${rc}`);
    this.generation++;
    this.decodeAll = true;
    this.allocView();
    // Reflow keeps Ghostty's viewport at the bottom; only the offset is clamped.
    if (this.offset > 0) this.setViewportOffset(this.offset);
  }

  setCellPixelSize(cellWidthPx: number, cellHeightPx: number): void {
    const w = Math.max(0, Math.round(cellWidthPx));
    const h = Math.max(0, Math.round(cellHeightPx));
    if (w === this.cellWidthPx && h === this.cellHeightPx) return;
    this.cellWidthPx = w;
    this.cellHeightPx = h;
    const rc = this.ex.ghostty_terminal_resize(this.term, this._cols, this._rows, w, h);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_resize failed: ${rc}`);
    this.generation++;
  }

  /**
   * Records the view's offset. Ghostty's viewport is not moved and nothing is
   * decoded: rows above the active screen come from the page cache, and the active
   * rows from the primary copy, so a scroll step costs no export call on a page hit.
   */
  setViewportOffset(linesFromBottom: number): void {
    this.info();
    const k = this.altScreen
      ? 0
      : Math.max(0, Math.min(Math.floor(linesFromBottom) || 0, this.sbRows));
    if (k === this.offset) return;
    // Scrolling changes no row: the renderer repaints what the move needs (ADR 043).
    this.offset = k;
  }

  free(): void {
    const ex = this.ex;
    if (!this.term) return;
    ex.ghostty_terminal_free(this.term);
    this.term = 0;
    // Slots are released only after nothing can call them (fn-table.ts rule 3).
    for (const fn of this.callbacks) fn.release();
    this.callbacks.length = 0;
    if (this.pageRs) ex.ghostty_render_state_free(this.pageRs);
    ex.ghostty_render_state_row_cells_free(this.rowCells);
    ex.ghostty_render_state_row_iterator_free(this.iter);
    ex.ghostty_render_state_free(this.rs);
    this.pageRs = 0;
    this.scratch.free();
  }

  // ==========================================================================
  // Render state
  // ==========================================================================

  update(): DirtyState {
    this.refresh();
    return this.dirtyMax;
  }

  getCursor(): RenderStateCursor {
    this.refresh();
    return {
      x: this.cursorX,
      y: this.cursorY,
      viewportX: this.cursorX,
      viewportY: this.cursorY,
      visible: this.cursorVisible,
      blinking: this.cursorBlinking,
      style: this.cursorStyle,
    };
  }

  getColors(): RenderStateColors {
    this.refresh();
    return {
      background: rgbObject(this.defBg),
      foreground: rgbObject(this.defFg),
      cursor: this.cursorColor === null ? null : rgbObject(this.cursorColor),
    };
  }

  isRowDirty(y: number): boolean {
    this.refresh();
    return this.dirtyMax === DirtyState.FULL || this.dirtyRows.has(y);
  }

  markClean(): void {
    this.dirtyRows.clear();
    this.dirtyMax = DirtyState.NONE;
  }

  getViewport(): GhosttyCell[] {
    this.refresh();
    // The active screen, scrolled or not.
    return this.viewCells;
  }

  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this._rows) return null;
    this.refresh();
    return this.copyRow(this.rowAt(this.sbRows + y));
  }

  isDirty(): boolean {
    return this.update() !== DirtyState.NONE;
  }

  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  clearDirty(): void {
    this.markClean();
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this._cols, rows: this._rows };
  }

  // ==========================================================================
  // Modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    this.info();
    return this.altScreen;
  }

  hasBracketedPaste(): boolean {
    return this.getMode(2004, false);
  }

  hasFocusEvents(): boolean {
    return this.getMode(1004, false);
  }

  hasMouseTracking(): boolean {
    const at = this.at;
    const rc = this.ex.ghostty_terminal_get(this.term, this.L.tdata.MOUSE_TRACKING, at.u8);
    return rc === 0 && this.u8()[at.u8] !== 0;
  }

  getMode(mode: number, isAnsi: boolean = false): boolean {
    const at = this.at;
    const M = this.L.mode;
    const dv = this.dv();
    // GhosttyMode (modes.h ghostty_mode_new): number in bits 0-14, bit 15 = ANSI.
    dv.setUint16(at.mode + M.mode, (mode & 0x7fff) | (isAnsi ? 0x8000 : 0), true);
    dv.setUint8(at.mode + M.value, 0);
    const rc = this.ex.ghostty_terminal_get(this.term, this.L.tdata.MODE, at.mode);
    return rc === 0 && this.u8()[at.mode + M.value] !== 0;
  }

  // ==========================================================================
  // Scrollback, graphemes, hyperlinks
  // ==========================================================================

  getScrollbackLength(): number {
    this.info();
    return this.sbRows;
  }

  getScrollbackLine(offset: number): GhosttyCell[] | null {
    this.refresh();
    if (offset < 0 || offset >= this.sbRows) return null;
    // A page's cells are never written after the page is read, so the row's cell
    // objects are shared, not copied; only the array is new.
    return this.readPage(offset).cells.slice();
  }

  isRowWrapped(row: number): boolean {
    if (row < 0 || row >= this._rows) return false;
    const at = this.at;
    if (!this.gridRef(this.L.point.ACTIVE, 0, row)) return false;
    if (this.ex.ghostty_grid_ref_row(at.gridRef, at.row64) !== 0) return false;
    const rowValue = this.dv().getBigUint64(at.row64, true);
    if (this.ex.ghostty_row_get(rowValue, this.L.rowWrapContinuation, at.u8) !== 0) return false;
    return this.u8()[at.u8] !== 0;
  }

  getHyperlinkUri(row: number, col: number): string | null {
    if (row < 0 || row >= this._rows) return null;
    return this.hyperlinkAt(this.L.point.ACTIVE, col, row);
  }

  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.hyperlinkAt(this.L.point.HISTORY, col, offset);
  }

  getGrapheme(row: number, col: number): number[] | null {
    if (row < 0 || row >= this._rows) return null;
    return this.codepointsOf(this.getGraphemeString(row, col));
  }

  getGraphemeString(row: number, col: number): string {
    if (row < 0 || row >= this._rows || col < 0 || col >= this._cols) return ' ';
    this.refresh();
    return this.graphemeOf(this.rowAt(this.sbRows + row), col);
  }

  getScrollbackGrapheme(offset: number, col: number): number[] | null {
    this.refresh();
    if (offset < 0 || offset >= this.sbRows) return null;
    return this.codepointsOf(this.getScrollbackGraphemeString(offset, col));
  }

  getScrollbackGraphemeString(offset: number, col: number): string {
    this.refresh();
    if (offset < 0 || offset >= this.sbRows || col < 0 || col >= this._cols) return ' ';
    return this.graphemeOf(this.rowAt(offset), col);
  }

  // ==========================================================================
  // Replies and effects
  // ==========================================================================

  hasResponse(): boolean {
    return this.responses.length > 0;
  }

  readResponse(): string | null {
    if (this.responses.length === 0) return null;
    let total = 0;
    for (const r of this.responses) total += r.length;
    const all = new Uint8Array(total);
    let off = 0;
    for (const r of this.responses) {
      all.set(r, off);
      off += r.length;
    }
    this.responses.length = 0;
    return new TextDecoder().decode(all);
  }

  readEffects(): TerminalEffects {
    const effects = { bell: this.bell, title: this.pendingTitle };
    this.bell = false;
    this.pendingTitle = null;
    return effects;
  }

  // ==========================================================================
  // Private: memory helpers
  // ==========================================================================

  /** A fresh byte view; never keep one across an export call. */
  private u8(): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer);
  }

  /** A fresh DataView; never keep one across an export call. */
  private dv(): DataView {
    return new DataView(this.ex.memory.buffer);
  }

  private setU32s(ptr: number, values: number[]): void {
    const dv = this.dv();
    values.forEach((v, i) => dv.setUint32(ptr + i * 4, v, true));
  }

  private rgbAt(ptr: number): number {
    const u8 = this.u8();
    const C = this.L.colors;
    return (u8[ptr + C.r] << 16) | (u8[ptr + C.g] << 8) | u8[ptr + C.b];
  }

  private writeRgb(ptr: number, rgb: number): void {
    const u8 = this.u8();
    const C = this.L.colors;
    u8[ptr + C.r] = (rgb >>> 16) & 0xff;
    u8[ptr + C.g] = (rgb >>> 8) & 0xff;
    u8[ptr + C.b] = rgb & 0xff;
  }

  private setOption(option: number, value: number, what: string): void {
    const rc = this.ex.ghostty_terminal_set(this.term, option, value);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_set ${what} failed: ${rc}`);
  }

  private scrollViewport(tag: number, row: number): void {
    const at = this.at;
    const S = this.L.scroll;
    const u8 = this.u8();
    u8.fill(0, at.scroll, at.scroll + S.size);
    const dv = this.dv();
    dv.setInt32(at.scroll + S.tag, tag, true);
    // The ROW arm is a usize (u32 on wasm32); the 8-byte union is zeroed above.
    dv.setUint32(at.scroll + S.value, row, true);
    this.ex.ghostty_terminal_scroll_viewport(this.term, at.scroll);
  }

  // ==========================================================================
  // Private: setup
  // ==========================================================================

  private installCallbacks(): void {
    const L = this.L;
    const table = this.vt.fnTable;
    const install = (
      option: number,
      what: string,
      fn: (...args: number[]) => number | undefined,
      params: number,
      returnsBool: boolean
    ) => {
      const installed = table.install(
        fn as (...args: number[]) => number | void,
        new Array(params).fill(I32),
        returnsBool ? [I32] : []
      );
      this.callbacks.push(installed);
      this.setOption(option, installed.index, what);
    };

    // WRITE_PTY(terminal, userdata, data, len): copy the reply out before returning.
    // Each call carries one whole reply. The kitty keyboard query reply is dropped:
    // webtty's input handler never encodes keys with the kitty flags, so answering
    // `CSI ? u` would tell apps the protocol is on when it is not (ADR 042).
    install(
      L.opt.WRITE_PTY,
      'WRITE_PTY',
      (_t, _u, ptr, len) => {
        const reply = this.u8().slice(ptr, ptr + len);
        if (!isKittyKeyboardReply(reply)) this.responses.push(reply);
        return undefined;
      },
      4,
      false
    );
    install(
      L.opt.BELL,
      'BELL',
      () => {
        this.bell = true;
        return undefined;
      },
      2,
      false
    );
    // The title is read after vt_write returns (DATA_TITLE), not inside the callback.
    install(
      L.opt.TITLE_CHANGED,
      'TITLE_CHANGED',
      () => {
        this.titleChanged = true;
        return undefined;
      },
      2,
      false
    );
    // SIZE(terminal, userdata, out): XTWINOPS 14/16/18/19 t and mode 2048 reports.
    install(
      L.opt.SIZE,
      'SIZE',
      (_t, _u, out) => {
        const Z = L.sizeReport;
        const dv = this.dv();
        dv.setUint16(out + Z.rows, this._rows, true);
        dv.setUint16(out + Z.columns, this._cols, true);
        dv.setUint32(out + Z.cellWidth, this.cellWidthPx, true);
        dv.setUint32(out + Z.cellHeight, this.cellHeightPx, true);
        return 1;
      },
      3,
      true
    );
    // DEVICE_ATTRIBUTES: ESC[?62;22c and ESC[>1;10;0c, as the Coder wasm answers.
    install(
      L.opt.DEVICE_ATTRIBUTES,
      'DEVICE_ATTRIBUTES',
      (_t, _u, out) => {
        const D = L.da;
        const dv = this.dv();
        const primary = out + D.primary;
        const secondary = out + D.secondary;
        dv.setUint16(primary + D.conformance, 62, true);
        dv.setUint16(primary + D.features, 22, true);
        dv.setUint32(primary + D.numFeatures, 1, true);
        dv.setUint16(secondary + D.deviceType, 1, true);
        dv.setUint16(secondary + D.firmware, 10, true);
        dv.setUint16(secondary + D.rom, 0, true);
        dv.setUint32(out + D.tertiary + D.unitId, 0, true);
        return 1;
      },
      3,
      true
    );
  }

  private applyConfig(config: GhosttyTerminalConfig | undefined): void {
    const L = this.L;
    const at = this.at;

    // Scrollback keeps today's derived byte budget (ADR 042). 0 bytes would disable
    // scrollback and NULL would remove the limit, so neither is ever passed.
    const limit = config?.scrollbackLimit ?? DEFAULT_SCROLLBACK_BYTES;
    this.dv().setUint32(at.u32, limit > 0 ? limit : UNLIMITED_SCROLLBACK_BYTES, true);
    this.setOption(L.opt.SCROLLBACK_MAX_BYTES, at.u32, 'SCROLLBACK_MAX_BYTES');

    // Grapheme clustering (mode 2027) on by default, so RIS keeps it.
    const dv = this.dv();
    dv.setUint16(at.mode + L.mode.mode, 2027, true);
    dv.setUint8(at.mode + L.mode.value, 1);
    this.setOption(L.opt.MODE_DEFAULT, at.mode, 'MODE_DEFAULT 2027');

    const given = config?.colorsSet;
    const isSet = (flag: boolean | undefined, value: number | undefined) =>
      given ? !!flag && value !== undefined : !!value;
    const setColor = (option: number, value: number, what: string) => {
      this.writeRgb(at.u32, value);
      this.setOption(option, at.u32, what);
    };
    // Foreground and background are always both set: Ghostty's render state copies
    // the default colours only when both are set (render.zig `bg_fg`), otherwise it
    // keeps white on black and ignores the given colour, OSC 10/11 and DECSCNM.
    // An unset one falls back to the Coder engine's effective default.
    setColor(
      L.opt.COLOR_FOREGROUND,
      isSet(given?.foreground, config?.fgColor) ? (config?.fgColor ?? 0) : FALLBACK_FOREGROUND,
      'COLOR_FOREGROUND'
    );
    setColor(
      L.opt.COLOR_BACKGROUND,
      isSet(given?.background, config?.bgColor) ? (config?.bgColor ?? 0) : FALLBACK_BACKGROUND,
      'COLOR_BACKGROUND'
    );
    if (!config) return;
    if (isSet(given?.cursor, config.cursorColor)) {
      setColor(L.opt.COLOR_CURSOR, config.cursorColor ?? 0, 'COLOR_CURSOR');
    }
    const palette = config.palette ?? [];
    const entries = palette
      .map((value, i) => ({ value, i }))
      .filter(({ value, i }) => i < 16 && isSet(given?.palette?.[i], value));
    if (entries.length > 0) {
      // Unset entries and 16-255 keep Ghostty's default palette.
      const rc = this.ex.ghostty_terminal_get(
        this.term,
        L.tdata.COLOR_PALETTE_DEFAULT,
        at.palette
      );
      if (rc !== 0) throw new Error(`libghostty-vt COLOR_PALETTE_DEFAULT failed: ${rc}`);
      for (const { value, i } of entries) this.writeRgb(at.palette + i * L.colors.rgbSize, value);
      this.setOption(L.opt.COLOR_PALETTE, at.palette, 'COLOR_PALETTE');
    }
  }

  private allocView(): void {
    const total = this._cols * this._rows;
    while (this.viewCells.length < total) this.viewCells.push(blankCell());
    this.viewCells.length = total;
    this.viewGraphemes = new Array(this._rows).fill(null);
  }

  // ==========================================================================
  // Private: refresh
  // ==========================================================================

  /** Cursor, scrollback rows and active screen, read once per generation. */
  private info(): void {
    if (this.infoGen === this.generation) return;
    const at = this.at;
    const rc = this.ex.ghostty_terminal_get_multi(this.term, 4, at.tKeys, at.tVals, 0);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_get_multi failed: ${rc}`);
    const dv = this.dv();
    this.cursorX = dv.getUint16(at.curX, true);
    this.cursorY = dv.getUint16(at.curY, true);
    this.sbRows = dv.getUint32(at.sbRows, true);
    this.altScreen = dv.getInt32(at.screen, true) === this.L.screenAlternate;
    this.infoGen = this.generation;
  }

  /**
   * Brings the active-screen copy up to date with the terminal, once per generation. Each
   * refresh decodes only the rows Ghostty reports dirty (every row after a resize or
   * colour change), adds them to the dirty set, and ends with `render_state_clean`,
   * which clears Ghostty's global and per-row dirty state. The JS dirty state
   * accumulates until `markClean()`.
   */
  private refresh(): void {
    if (this.refreshedGen === this.generation) return;
    this.info();
    const ex = this.ex;
    const L = this.L;
    const at = this.at;

    let rc = ex.ghostty_render_state_update(this.rs, this.term);
    if (rc !== 0) throw new Error(`libghostty-vt render_state_update failed: ${rc}`);
    let dv = this.dv();
    dv.setUint32(at.cursor + L.cursor.sizeField, L.cursor.size, true);
    dv.setUint32(at.colors + L.colors.sizeField, L.colors.size, true);
    rc = ex.ghostty_render_state_get_multi(this.rs, 3, at.rsKeys, at.rsVals, 0);
    if (rc !== 0) throw new Error(`libghostty-vt render_state_get_multi failed: ${rc}`);
    // Decoded cells carry the default fg/bg and palette colours, but Ghostty marks no
    // row dirty when only the defaults change (OSC 10/11/110/111, DECSCNM): its own
    // renderer applies them globally. Redecode every row when any colour changed.
    const colorsChanged = this.readCursorAndColors();
    dv = this.dv();
    const dirty = dv.getInt32(at.dirty, true);
    rc = ex.ghostty_render_state_get(this.rs, L.rs.ROW_ITERATOR, at.iterH);
    if (rc !== 0) throw new Error(`libghostty-vt ROW_ITERATOR failed: ${rc}`);

    const all = this.decodeAll || colorsChanged;
    const cols = this._cols;
    while (
      all
        ? ex.ghostty_render_state_row_iterator_next(this.iter)
        : ex.ghostty_render_state_row_iterator_next_dirty(this.iter, at.y)
    ) {
      const len = this.readRowRaw();
      const y = this.dv().getInt32(at.viewY, true);
      if (y < 0 || y >= this._rows) continue;
      this.viewGraphemes[y] = this.decodeRow(this.viewCells, y * cols, len);
      this.dirtyRows.add(y);
    }
    ex.ghostty_render_state_clean(this.rs);

    const level = all
      ? DirtyState.FULL
      : dirty === L.dirty.FULL
        ? DirtyState.FULL
        : dirty === L.dirty.PARTIAL
          ? DirtyState.PARTIAL
          : DirtyState.NONE;
    if (level > this.dirtyMax) this.dirtyMax = level;
    this.decodeAll = false;
    this.refreshedGen = this.generation;
  }

  /** Returns whether the default colours or the palette changed since the last read. */
  private readCursorAndColors(): boolean {
    const L = this.L;
    const at = this.at;
    const u8 = this.u8();
    const dv = this.dv();
    const C = L.cursor;
    this.cursorVisible = u8[at.cursor + C.visible] !== 0;
    this.cursorBlinking = u8[at.cursor + C.blinking] !== 0;
    const style = dv.getInt32(at.cursor + C.visualStyle, true);
    this.cursorStyle =
      style === L.cursorStyle.BAR ? 'bar' : style === L.cursorStyle.UNDERLINE ? 'underline' : 'block';
    const K = L.colors;
    const defBg = this.rgbAt(at.colors + K.background);
    const defFg = this.rgbAt(at.colors + K.foreground);
    let changed = defBg !== this.defBg || defFg !== this.defFg;
    this.defBg = defBg;
    this.defFg = defFg;
    this.cursorColor = u8[at.colors + K.cursorHasValue] ? this.rgbAt(at.colors + K.cursor) : null;
    const pal = at.colors + K.palette;
    const out = this.palette;
    for (let i = 0; i < 256; i++) {
      const p = pal + i * K.rgbSize;
      const r = u8[p + K.r];
      const g = u8[p + K.g];
      const b = u8[p + K.b];
      if (out[i * 3] !== r || out[i * 3 + 1] !== g || out[i * 3 + 2] !== b) {
        changed = true;
        out[i * 3] = r;
        out[i * 3 + 1] = g;
        out[i * 3 + 2] = b;
      }
    }
    return changed;
  }

  /**
   * Reads the iterator's current row (CELLS_RAW, VIEWPORT_Y, and binds the row-cells
   * handle) and copies the raw cells into the JS-owned `raw` array at once.
   */
  private readRowRaw(): number {
    const at = this.at;
    const L = this.L;
    const rc = this.ex.ghostty_render_state_row_get_multi(this.iter, 3, at.rowKeys, at.rowVals, 0);
    if (rc !== 0) throw new Error(`libghostty-vt render_state_row_get_multi failed: ${rc}`);
    const dv = this.dv();
    const ptr = dv.getUint32(at.view + L.cellsView.ptr, true);
    const len = dv.getUint32(at.view + L.cellsView.len, true);
    const words = (len * L.cellSize) / 4;
    if (this.raw.length < words) this.raw = new Uint32Array(words);
    if (ptr && words) this.raw.set(new Uint32Array(this.ex.memory.buffer, ptr, words));
    return len;
  }

  /**
   * Decodes the copied raw row into `out[base..base+cols)`. Styles come from a
   * per-row cache (`row_cells_get` STYLE only for an id not seen in the row), and
   * grapheme codepoints are read only for cells tagged as graphemes.
   */
  private decodeRow(out: GhosttyCell[], base: number, len: number): Map<number, string> | null {
    const L = this.L;
    const B = L.cell;
    // Hoisted: this loop runs once per cell of every decoded row.
    const tagLsb = B.tag.lsb;
    const tagMask = B.tag.mask;
    const contentLsb = B.content.lsb;
    const contentMask = B.content.mask;
    const styleLsb = B.style.lsb;
    const styleMask = B.style.mask;
    const wideLsb = B.wide.lsb;
    const wideMask = B.wide.mask;
    const linkLsb = B.hyperlink.lsb;
    const linkMask = B.hyperlink.mask;
    const cpLsb = B.codepoint.lsb;
    const cpMask = B.codepoint.mask;
    const TAG_CP = L.tag.CODEPOINT;
    const TAG_GRAPHEME = L.tag.CODEPOINT_GRAPHEME;
    const TAG_BG_PALETTE = L.tag.BG_COLOR_PALETTE;
    const TAG_BG_RGB = L.tag.BG_COLOR_RGB;
    const WIDE = L.wide.WIDE;
    const NARROW = L.wide.NARROW;
    const defFg = this.defFg;
    const defBg = this.defBg;
    const raw = this.raw;
    const pal = this.palette;
    const words = L.cellSize / 4;
    const styles = this.rowStyles;
    styles.clear();
    let graphemes: Map<number, string> | null = null;
    const n = Math.min(len, this._cols);
    for (let x = 0; x < n; x++) {
      const lo = raw[x * words];
      const hi = raw[x * words + 1];
      const tag = readBits(lo, hi, tagLsb, tagMask);
      const content = readBits(lo, hi, contentLsb, contentMask);
      const styleId = readBits(lo, hi, styleLsb, styleMask);
      const wide = readBits(lo, hi, wideLsb, wideMask);
      const cell = out[base + x];
      let fg = defFg;
      let bg = defBg;
      let flags = 0;
      let codepoint = 0;
      let bgFromContent = false;
      if (tag === TAG_CP || tag === TAG_GRAPHEME) {
        codepoint = (content >>> cpLsb) & cpMask;
      } else if (tag === TAG_BG_PALETTE) {
        const i = readBits(content, 0, B.paletteIndex.lsb, B.paletteIndex.mask) * 3;
        bg = (pal[i] << 16) | (pal[i + 1] << 8) | pal[i + 2];
        bgFromContent = true;
      } else if (tag === TAG_BG_RGB) {
        bg =
          (readBits(content, 0, B.r.lsb, B.r.mask) << 16) |
          (readBits(content, 0, B.g.lsb, B.g.mask) << 8) |
          readBits(content, 0, B.b.lsb, B.b.mask);
        bgFromContent = true;
      }
      if (styleId !== 0) {
        let style = styles.get(styleId);
        if (!style) {
          style = this.readStyle(x);
          styles.set(styleId, style);
        }
        if (style.fg >= 0) fg = style.fg;
        if (style.bg >= 0 && !bgFromContent) bg = style.bg;
        flags = style.flags;
      }
      cell.codepoint = codepoint;
      cell.fg_r = (fg >>> 16) & 0xff;
      cell.fg_g = (fg >>> 8) & 0xff;
      cell.fg_b = fg & 0xff;
      cell.bg_r = (bg >>> 16) & 0xff;
      cell.bg_g = (bg >>> 8) & 0xff;
      cell.bg_b = bg & 0xff;
      cell.flags = flags;
      cell.width = wide === WIDE ? 2 : wide === NARROW ? 1 : 0;
      cell.hyperlink_id = readBits(lo, hi, linkLsb, linkMask);
      cell.grapheme_len = 0;
      if (tag === TAG_GRAPHEME) {
        const cps = this.readGrapheme(x);
        if (cps.length > 1) {
          cell.grapheme_len = cps.length - 1;
          (graphemes ??= new Map()).set(x, String.fromCodePoint(...cps));
        }
      }
    }
    for (let x = n; x < this._cols; x++) {
      const cell = out[base + x];
      cell.codepoint = 0;
      setRgb(cell, defFg, defBg);
      cell.flags = 0;
      cell.width = 1;
      cell.hyperlink_id = 0;
      cell.grapheme_len = 0;
    }
    return graphemes;
  }

  private readStyle(x: number): DecodedStyle {
    const L = this.L;
    const S = L.style;
    const C = L.styleColor;
    const p = this.at.style;
    const ex = this.ex;
    ex.ghostty_render_state_row_cells_select(this.rowCells, x);
    new DataView(ex.memory.buffer).setUint32(p + S.sizeField, S.size, true);
    if (ex.ghostty_render_state_row_cells_get(this.rowCells, L.cellData.STYLE, p) !== 0) {
      return { fg: -1, bg: -1, flags: 0 };
    }
    const dv = new DataView(ex.memory.buffer);
    const pal = this.palette;
    let fg = -1;
    let bg = -1;
    for (let side = 0; side < 2; side++) {
      const at = p + (side === 0 ? S.fg : S.bg);
      const tag = dv.getInt32(at + C.tag, true);
      const v = at + C.value;
      let rgb = -1;
      if (tag === C.PALETTE) {
        const i = dv.getUint8(v + C.palette) * 3;
        rgb = (pal[i] << 16) | (pal[i + 1] << 8) | pal[i + 2];
      } else if (tag === C.RGB) {
        const c = v + C.rgb;
        const K = L.colors;
        rgb = (dv.getUint8(c + K.r) << 16) | (dv.getUint8(c + K.g) << 8) | dv.getUint8(c + K.b);
      }
      if (side === 0) fg = rgb;
      else bg = rgb;
    }
    const flags =
      (dv.getUint8(p + S.bold) ? CellFlags.BOLD : 0) |
      (dv.getUint8(p + S.italic) ? CellFlags.ITALIC : 0) |
      (dv.getInt32(p + S.underline, true) ? CellFlags.UNDERLINE : 0) |
      (dv.getUint8(p + S.strikethrough) ? CellFlags.STRIKETHROUGH : 0) |
      (dv.getUint8(p + S.inverse) ? CellFlags.INVERSE : 0) |
      (dv.getUint8(p + S.invisible) ? CellFlags.INVISIBLE : 0) |
      (dv.getUint8(p + S.blink) ? CellFlags.BLINK : 0) |
      (dv.getUint8(p + S.faint) ? CellFlags.FAINT : 0);
    return { fg, bg, flags };
  }

  private readGrapheme(x: number): number[] {
    const L = this.L;
    const at = this.at;
    const ex = this.ex;
    ex.ghostty_render_state_row_cells_select(this.rowCells, x);
    if (ex.ghostty_render_state_row_cells_get(this.rowCells, L.cellData.GRAPHEMES_LEN, at.u32)) {
      return [];
    }
    const n = this.dv().getUint32(at.u32, true);
    if (n === 0) return [];
    const big = n > GRAPHEME_SCRATCH;
    const buf = big ? ex.ghostty_wasm_alloc(n * 4) : at.gBuf;
    try {
      if (ex.ghostty_render_state_row_cells_get(this.rowCells, L.cellData.GRAPHEMES_BUF, buf)) {
        return [];
      }
      const dv = this.dv();
      const cps: number[] = [];
      for (let i = 0; i < n; i++) cps.push(dv.getUint32(buf + i * 4, true));
      return cps;
    } finally {
      if (big) ex.ghostty_wasm_free(buf, n * 4);
    }
  }

  // ==========================================================================
  // Private: rows by absolute index (0 = oldest scrollback row)
  // ==========================================================================

  /** A row by absolute index; call `refresh()` first. */
  private rowAt(abs: number): RowRef {
    if (abs >= this.sbRows) {
      const y = abs - this.sbRows;
      return { cells: this.viewCells, base: y * this._cols, graphemes: this.viewGraphemes[y] };
    }
    return this.readPage(abs);
  }

  /**
   * Reads the page of `rows` rows holding scrollback row `abs` through a second
   * render state: moves Ghostty's viewport there, reads every row with CELLS_RAW,
   * and moves it back to the bottom. The primary state has already been refreshed
   * at this generation (callers refresh first), so it has captured every pending
   * dirty bit before the second state's update consumes the terminal's dirty state.
   * The second state cannot trust dirty bits the primary has cleared, so it is
   * recreated whenever the content has changed, and every miss rebuilds every row
   * it reads. Scrolling changes no row, so the state and the pages are kept.
   */
  private readPage(abs: number): RowRef {
    const rows = this._rows;
    // abs < S, so the page starts in scrollback: scroll_viewport ROW n snaps to the
    // active screen only for n >= S. A page may run on into active rows; rowAt
    // serves those from the primary copy.
    const start = Math.floor(abs / rows) * rows;
    if (this.pageGen !== this.generation) {
      if (this.pageRs) this.ex.ghostty_render_state_free(this.pageRs);
      this.pageRs = this.vt.newHandle('render_state_new', (slot) =>
        this.ex.ghostty_render_state_new(0, slot)
      );
      this.pages.clear();
      this.pageGen = this.generation;
    }
    let page = this.pages.get(start);
    if (page) {
      this.pages.delete(start);
      this.pages.set(start, page);
      return page[abs - start];
    }

    const ex = this.ex;
    const L = this.L;
    const at = this.at;
    this.scrollViewport(L.scroll.ROW, start);
    try {
      const rc = ex.ghostty_render_state_update(this.pageRs, this.term);
      if (rc !== 0) throw new Error(`libghostty-vt render_state_update failed: ${rc}`);
      if (ex.ghostty_render_state_get(this.pageRs, L.rs.ROW_ITERATOR, at.iterH) !== 0) {
        throw new Error('libghostty-vt ROW_ITERATOR failed');
      }
      page = [];
      while (ex.ghostty_render_state_row_iterator_next(this.iter)) {
        const len = this.readRowRaw();
        const y = this.dv().getInt32(at.viewY, true);
        if (y < 0 || y >= rows) continue;
        const cells: GhosttyCell[] = [];
        for (let x = 0; x < this._cols; x++) cells.push(blankCell());
        page[y] = { cells, base: 0, graphemes: this.decodeRow(cells, 0, len) };
      }
    } finally {
      this.scrollViewport(L.scroll.BOTTOM, 0);
    }
    for (let y = 0; y < rows; y++) {
      if (!page[y]) {
        const cells: GhosttyCell[] = [];
        for (let x = 0; x < this._cols; x++) cells.push(blankCell());
        page[y] = { cells, base: 0, graphemes: null };
      }
    }
    this.pages.set(start, page);
    if (this.pages.size > PAGE_CACHE_SIZE) {
      const oldest = this.pages.keys().next().value;
      if (oldest !== undefined) this.pages.delete(oldest);
    }
    return page[abs - start];
  }

  private copyRow(ref: RowRef): GhosttyCell[] {
    const out: GhosttyCell[] = new Array(this._cols);
    for (let x = 0; x < this._cols; x++) out[x] = { ...ref.cells[ref.base + x] };
    return out;
  }

  private graphemeOf(ref: RowRef, col: number): string {
    const g = ref.graphemes?.get(col);
    if (g !== undefined) return g;
    const cp = ref.cells[ref.base + col].codepoint;
    return cp ? String.fromCodePoint(cp) : ' ';
  }

  private codepointsOf(s: string): number[] {
    const cps: number[] = [];
    for (const ch of s) cps.push(ch.codePointAt(0) ?? 0);
    return cps;
  }

  // ==========================================================================
  // Private: single-cell lookups (grid_ref)
  // ==========================================================================

  /** Resolves a point to a grid reference at `at.gridRef`. */
  private gridRef(tag: number, x: number, y: number): boolean {
    const L = this.L;
    const at = this.at;
    const P = L.point;
    this.u8().fill(0, at.point, at.point + P.size);
    const dv = this.dv();
    dv.setInt32(at.point + P.tag, tag, true);
    dv.setUint16(at.point + P.value + P.x, x, true);
    dv.setUint32(at.point + P.value + P.y, y, true);
    this.u8().fill(0, at.gridRef, at.gridRef + L.gridRef.size);
    dv.setUint32(at.gridRef + L.gridRef.sizeField, L.gridRef.size, true);
    return this.ex.ghostty_terminal_grid_ref(this.term, at.point, at.gridRef) === 0;
  }

  private hyperlinkAt(tag: number, x: number, y: number): string | null {
    if (x < 0 || x >= this._cols || y < 0) return null;
    const ex = this.ex;
    const at = this.at;
    if (!this.gridRef(tag, x, y)) return null;
    // Most URIs fit; a longer one (Ghostty keeps OSC 8 URIs up to about 2 KiB) is
    // read again with the size Ghostty reports.
    let cap = 256;
    for (let attempt = 0; attempt < 2; attempt++) {
      const size = cap;
      const buf = ex.ghostty_wasm_alloc(size);
      try {
        const rc = ex.ghostty_grid_ref_hyperlink_uri(at.gridRef, buf, size, at.u32);
        const n = this.dv().getUint32(at.u32, true);
        if (rc === this.L.result.OUT_OF_SPACE) {
          cap = n;
          continue;
        }
        if (rc !== 0 || n === 0) return null;
        return new TextDecoder().decode(this.u8().slice(buf, buf + n));
      } finally {
        ex.ghostty_wasm_free(buf, size);
      }
    }
    return null;
  }

  private readTitle(): void {
    this.titleChanged = false;
    const at = this.at;
    const S = this.L.string;
    if (this.ex.ghostty_terminal_get(this.term, this.L.tdata.TITLE, at.str) !== 0) return;
    const dv = this.dv();
    const ptr = dv.getUint32(at.str + S.ptr, true);
    const len = dv.getUint32(at.str + S.len, true);
    this.pendingTitle = len ? new TextDecoder().decode(this.u8().slice(ptr, ptr + len)) : '';
  }
}

/**
 * Key encoder on the official wasm. ghostty-web's `Key`, `KeyAction` and
 * `KeyEncoderOption` values are translated by name to the official enums.
 */
class OfficialKeyEncoder implements KeyEncoder {
  private readonly vt: OfficialGhostty;
  private readonly ex: OfficialWasmExports;
  private encoder: number;
  private readonly value: number;
  private readonly written: number;

  constructor(vt: OfficialGhostty) {
    this.vt = vt;
    this.ex = vt.ex;
    this.encoder = vt.newHandle('key_encoder_new', (slot) => this.ex.ghostty_key_encoder_new(0, slot));
    this.value = this.ex.ghostty_wasm_alloc(8);
    this.written = this.ex.ghostty_wasm_alloc(8);
  }

  setOption(option: KeyEncoderOption, value: boolean | number): void {
    const official = this.vt.encoderOptions.get(option);
    if (official === undefined) return;
    // Every option ghostty-web sets is a bool or the u8 kitty flags.
    new DataView(this.ex.memory.buffer).setUint8(
      this.value,
      typeof value === 'boolean' ? (value ? 1 : 0) : value
    );
    this.ex.ghostty_key_encoder_setopt(this.encoder, official, this.value);
  }

  setKittyFlags(flags: KittyKeyFlags): void {
    this.setOption(KeyEncoderOption.KITTY_KEYBOARD_FLAGS, flags);
  }

  encode(event: KeyEvent): Uint8Array {
    const ex = this.ex;
    const vt = this.vt;
    const ev = vt.newHandle('key_event_new', (slot) => ex.ghostty_key_event_new(0, slot));
    let utf8Ptr = 0;
    let utf8Len = 0;
    let buf = 0;
    let cap = 64;
    try {
      ex.ghostty_key_event_set_action(ev, vt.keyActions.get(event.action) ?? event.action);
      ex.ghostty_key_event_set_key(ev, vt.keys.get(event.key) ?? vt.unidentifiedKey);
      ex.ghostty_key_event_set_mods(ev, event.mods);
      if (event.utf8) {
        const bytes = new TextEncoder().encode(event.utf8);
        utf8Len = bytes.length;
        utf8Ptr = ex.ghostty_wasm_alloc(utf8Len);
        new Uint8Array(ex.memory.buffer).set(bytes, utf8Ptr);
        // The event does not copy the text; it stays allocated until after encode.
        ex.ghostty_key_event_set_utf8(ev, utf8Ptr, utf8Len);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        buf = ex.ghostty_wasm_alloc(cap);
        const rc = ex.ghostty_key_encoder_encode(this.encoder, ev, buf, cap, this.written);
        const n = new DataView(ex.memory.buffer).getUint32(this.written, true);
        if (rc === vt.L.result.OUT_OF_SPACE && attempt === 0) {
          ex.ghostty_wasm_free(buf, cap);
          buf = 0;
          cap = n;
          continue;
        }
        if (rc !== 0) throw new Error(`Failed to encode key: ${rc}`);
        return new Uint8Array(ex.memory.buffer, buf, n).slice();
      }
      throw new Error('Failed to encode key: out of space');
    } finally {
      if (buf) ex.ghostty_wasm_free(buf, cap);
      if (utf8Ptr) ex.ghostty_wasm_free(utf8Ptr, utf8Len);
      ex.ghostty_key_event_free(ev);
    }
  }

  dispose(): void {
    if (this.encoder) {
      this.ex.ghostty_key_encoder_free(this.encoder);
      this.ex.ghostty_wasm_free(this.value, 8);
      this.ex.ghostty_wasm_free(this.written, 8);
      this.encoder = 0;
    }
  }
}
