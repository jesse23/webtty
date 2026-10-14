/**
 * TypeScript wrapper for libghostty-vt WASM API
 *
 * High-performance terminal emulation using Ghostty's battle-tested VT100 parser.
 * The key optimization is the RenderState API which provides a pre-computed
 * snapshot of all render data in a single update call.
 *
 * webtty (ADR 041, ADR 042, ADR 047): the binding to Ghostty's official,
 * unpatched libghostty-vt wasm. `OfficialTerminal` implements the `GhosttyTerminal`
 * interface the rest of the terminal layer uses. Every wasm export call and wasm
 * memory access is in this file and engine/, which holds the engine's interfaces, the
 * export typing, the manifest layout and the pure helpers (ADR 061).
 */

import { scanCursorBlink } from './engine/cursor-blink';
import type {
  DesktopNotification,
  EngineHost,
  GhosttyTerminal,
  KeyEncoder,
  MouseGeometry,
  MouseInput,
  ScreenCell,
  ScreenRange,
  SearchState,
  TerminalEffects,
} from './engine/engine-types';
import { OfficialKeyEncoder } from './engine/key-encoder-binding';
import {
  OFFICIAL_ENCODER_OPTION_NAMES,
  OFFICIAL_KEY_NAMES,
  translateEnum,
} from './engine/key-tables';
import { isKittyKeyboardReply } from './engine/kitty-keyboard-reply';
import { type OfficialLayout, resolveOfficialLayout } from './engine/official-layout';
import { Scratch } from './engine/scratch';
import { isTextMime } from './engine/text-mime';
import { readBits, readVtLayout } from './engine/vt-layout';
import type { OfficialWasmExports } from './engine/wasm-exports';
import { loadWasmExports } from './engine/wasm-loader';
import { FnTable, type InstalledFn, WasmValType } from './fn-table';
import {
  CellFlags,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  Key,
  KeyAction,
  KeyEncoderOption,
  type RenderStateCursor,
} from './types';

// Re-export types for convenience
export {
  CellFlags,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  type RenderStateCursor,
};
// The engine's interfaces and pure helpers live in engine/ (ADR 061); this file keeps
// exporting them so its importers do not change.
export type {
  DesktopNotification,
  GhosttyTerminal,
  KeyEncoder,
  MouseButton,
  MouseGeometry,
  MouseInput,
  ScreenCell,
  ScreenRange,
  SearchState,
  TerminalEffects,
} from './engine/engine-types';
export { scanCursorBlink } from './engine/cursor-blink';
export { isTextMime } from './engine/text-mime';

// Rules of the official libghostty-vt binding (ADR 041, ADR 042):
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

/**
 * A loaded libghostty-vt wasm instance (ADR 041, ADR 042): creates terminals and
 * key encoders.
 */
export class Ghostty implements EngineHost {
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

  constructor(exports: OfficialWasmExports) {
    this.ex = exports;
    const layout = readVtLayout(exports);
    this.L = resolveOfficialLayout(layout);
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

  /**
   * Loads the official wasm from `wasmPath`, or from the pinned copy beside this layer
   * (engine/wasm-loader.ts, ADR 061).
   */
  static async load(wasmPath?: string): Promise<Ghostty> {
    return new Ghostty(await loadWasmExports(wasmPath));
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
/** The scrollback byte ceiling under the line limit (ADR 046). */
const SCROLLBACK_CEILING_BYTES = 32 * 1024 * 1024;
/** History in lines when the config gives none (ADR 046, ADR 047). */
const DEFAULT_SCROLLBACK_LINES = 10000;
/** webtty's default colours, used when the theme leaves one unset. */
const FALLBACK_FOREGROUND = 0xcccccc;
const FALLBACK_BACKGROUND = 0x000000;
/** Grapheme codepoints read through the scratch buffer; longer clusters allocate. */
const GRAPHEME_SCRATCH = 32;
/** Room for one mouse report; the longest, SGR-pixels, is under 32 bytes. */
const MOUSE_REPORT_MAX = 64;
/** Room for one focus report (`CSI I` / `CSI O`, 3 bytes). */
const FOCUS_REPORT_MAX = 8;
/**
 * The modes that set the mouse encoder's tracking mode and format: X10, normal, button,
 * any-event tracking, and the UTF-8, SGR, urxvt and SGR-pixels formats.
 */
const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016];
/** DEC private mode 12, AT&T cursor blink (ATT610). */
const MODE_CURSOR_BLINK = 12;
/** Bytes as one char each, for scanning ASCII sequences in byte output. */
const LATIN1 = new TextDecoder('latin1');

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
  private readonly vt: Ghostty;
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
    | 'scrollbar'
    | 'point'
    | 'gridRef'
    | 'sel'
    | 'selOpts'
    | 'coord'
    | 'outPtr'
    | 'outLen'
    | 'row64'
    | 'str'
    | 'mode'
    | 'u32'
    | 'u8'
    | 'gBuf'
    | 'palette'
    | 'mouseSize'
    | 'mousePos'
    | 'mouseOut'
    | 'focusOut'
    | 'clipReply'
    | 'searchBuf',
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
  // The blink DECSCUSR set, or the default while it has not set one; DEC mode 12 is
  // ignored, so Ghostty's mode bit is put back to it after every write (ADR 049).
  private blinkDefault = false;
  private blinkIsDefault = true;
  private blink = false;
  private blinkCarry = '';
  private defFg = 0xffffff;
  private defBg = 0;
  private readonly palette = new Uint8Array(256 * 3);

  // The view's offset: lines scrolled up from the bottom. Ghostty's viewport stays at
  // the bottom; only page reads move it, and they move it back.
  private offset = 0;

  // Scrollback rows, keyed by the absolute row their page starts at.
  private readonly pages = new Map<number, RowRef[]>();
  private pageGen = 0;

  // Mouse encoder and event, made on the first report (ADR 049). `mouseModes` is the
  // MOUSE_MODES bitmask the encoder was last set from; `mouseGeometry` the last size.
  private mouseEncoder = 0;
  private mouseEvent = 0;
  private mouseModes = -1;
  private mouseGeometry = '';

  // Paste: the mime reader callback, installed on the first paste, and the text it
  // writes during a `paste` call (ADR 049).
  private pasteReader = 0;
  private pasteText = { ptr: 0, len: 0 };

  // Effects.
  private readonly responses: Uint8Array[] = [];
  private bell = false;
  private titleChanged = false;
  private pendingTitle: string | null = null;
  private pendingClipboard: string | null = null;
  private pendingNotifications: DesktopNotification[] = [];

  // Search (ADR 055): the handle while a needle is set, the generation it last fed, and
  // the wasm buffer matches are read into, grown as needed.
  private search = 0;
  private searchFedGen = 0;
  private matchBuf = 0;
  private matchCap = 0;

  constructor(vt: Ghostty, cols: number, rows: number, config?: GhosttyTerminalConfig) {
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
      scrollbar: [L.scrollbar.size, 8],
      point: [L.point.size, 8],
      gridRef: [L.gridRef.size, 8],
      sel: [L.selection.size, 8],
      selOpts: [
        Math.max(L.selection.word.size, L.selection.line.size, L.selection.format.size),
        8,
      ],
      coord: [8, 8],
      outPtr: [4, 4],
      outLen: [4, 4],
      row64: [8, 8],
      str: [L.string.size, 8],
      mode: [L.mode.size, 8],
      u32: [8, 8],
      u8: [8, 8],
      gBuf: [GRAPHEME_SCRATCH * 4, 8],
      palette: [256 * L.colors.rgbSize, 8],
      mouseSize: [L.mouse.size, 8],
      mousePos: [L.mouse.positionSize, 8],
      mouseOut: [MOUSE_REPORT_MAX, 8],
      focusOut: [FOCUS_REPORT_MAX, 8],
      clipReply: [L.clipboardWrite.replySize, 8],
      searchBuf: [L.search.bufferSize, 8],
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

    this.installCallbacks(
      config?.clipboardWrite ?? true,
      config?.desktopNotifications ?? true
    );
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
    this.feed(bytes, typeof data === 'string' ? data : undefined, false);
  }

  writeUntilGround(data: Uint8Array): number | null {
    return this.feed(data, undefined, true);
  }

  /** vt_write, or vt_write_until_ground: the bytes consumed, null if ground was not reached. */
  private feed(bytes: Uint8Array, text: string | undefined, untilGround: boolean): number | null {
    // Writes never leave the view scrolled (terminal.ts scrolls to the bottom after
    // writing); the first frame at the bottom repaints every row.
    if (this.offset !== 0) {
      this.offset = 0;
      this.dirtyMax = DirtyState.FULL;
    }
    const ex = this.ex;
    let consumed: number | null = bytes.length;
    // until_ground takes NULL for no bytes, and then only says whether it is at ground
    const ptr = bytes.length > 0 ? ex.ghostty_wasm_alloc(bytes.length) : 0;
    if (bytes.length > 0 && !ptr) throw new Error('libghostty-vt: out of memory');
    if (ptr) this.u8().set(bytes, ptr);
    if (untilGround) {
      const rc = ex.ghostty_terminal_vt_write_until_ground(this.term, ptr, bytes.length, this.at.u32);
      consumed = rc === this.L.result.SUCCESS ? this.dv().getUint32(this.at.u32, true) : null;
    } else if (ptr) {
      ex.ghostty_terminal_vt_write(this.term, ptr, bytes.length);
    }
    if (ptr) ex.ghostty_wasm_free(ptr, bytes.length);
    const fed = consumed ?? bytes.length;
    if (fed > 0) {
      const scan = scanCursorBlink(
        text ?? LATIN1.decode(bytes.subarray(0, fed)),
        this.blinkCarry
      );
      this.blinkCarry = scan.carry;
      if (scan.ps !== undefined) {
        this.blinkIsDefault = scan.ps === 0;
        this.blink = scan.ps === 0 ? this.blinkDefault : scan.ps % 2 === 1;
      }
      this.syncBlink();
    }
    this.generation++;
    if (this.titleChanged) this.readTitle();
    return consumed;
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

  setDefaultCursor(style: RenderStateCursor['style'], blink: boolean): void {
    const L = this.L;
    const at = this.at;
    this.dv().setInt32(at.u32, L.defaultCursorStyle[style], true);
    this.setOption(L.opt.DEFAULT_CURSOR_STYLE, at.u32, 'DEFAULT_CURSOR_STYLE');
    this.u8()[at.u8] = blink ? 1 : 0;
    this.setOption(L.opt.DEFAULT_CURSOR_BLINK, at.u8, 'DEFAULT_CURSOR_BLINK');
    this.blinkDefault = blink;
    if (this.blinkIsDefault) this.blink = blink;
    this.syncBlink();
    // The cursor is read from the render state, which only a content change refreshes.
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
    this.setSearch('');
    ex.ghostty_terminal_free(this.term);
    this.term = 0;
    // Slots are released only after nothing can call them (fn-table.ts rule 3).
    for (const fn of this.callbacks) fn.release();
    this.callbacks.length = 0;
    if (this.mouseEncoder) ex.ghostty_mouse_encoder_free(this.mouseEncoder);
    if (this.mouseEvent) ex.ghostty_mouse_event_free(this.mouseEvent);
    this.mouseEncoder = 0;
    this.mouseEvent = 0;
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

  hasMouseTracking(): boolean {
    const at = this.at;
    const rc = this.ex.ghostty_terminal_get(this.term, this.L.tdata.MOUSE_TRACKING, at.u8);
    return rc === 0 && this.u8()[at.u8] !== 0;
  }

  cursorAtPrompt(): boolean {
    const at = this.at;
    const rc = this.ex.ghostty_terminal_get(this.term, this.L.tdata.CURSOR_AT_PROMPT, at.u8);
    return rc === 0 && this.u8()[at.u8] !== 0;
  }

  promptJumpRow(top: number, delta: number): number {
    const at = this.at;
    const S = this.L.scroll;
    this.info();
    // Ghostty moves its viewport from its top row, so it is put on webtty's for the move
    this.scrollViewport(S.ROW, top);
    try {
      this.scrollViewport(S.DELTA_PROMPT, delta);
      const rc = this.ex.ghostty_terminal_get(this.term, this.L.tdata.SCROLLBAR, at.scrollbar);
      if (rc !== 0) return top;
      // The offset is a u64; a screen row fits in the low 32 bits
      return this.dv().getUint32(at.scrollbar + this.L.scrollbar.offset, true);
    } finally {
      this.scrollViewport(S.BOTTOM, 0);
    }
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

  getGraphemeString(row: number, col: number): string {
    if (row < 0 || row >= this._rows || col < 0 || col >= this._cols) return ' ';
    this.refresh();
    return this.graphemeOf(this.rowAt(this.sbRows + row), col);
  }

  getScrollbackGraphemeString(offset: number, col: number): string {
    this.refresh();
    if (offset < 0 || offset >= this.sbRows || col < 0 || col >= this._cols) return ' ';
    return this.graphemeOf(this.rowAt(offset), col);
  }

  // ==========================================================================
  // Selection (ADR 050)
  // ==========================================================================

  selectWord(cell: ScreenCell): ScreenRange | null {
    const W = this.L.selection.word;
    return this.selectAt(W, cell, (opts, out) =>
      this.ex.ghostty_terminal_select_word(this.term, opts, out)
    );
  }

  selectLine(cell: ScreenCell): ScreenRange | null {
    const W = this.L.selection.line;
    return this.selectAt(W, cell, (opts, out) =>
      this.ex.ghostty_terminal_select_line(this.term, opts, out)
    );
  }

  selectOutput(cell: ScreenCell): ScreenRange | null {
    const at = this.at;
    const S = this.L.selection;
    this.info();
    if (!this.screenRef(cell, at.gridRef)) return null;
    this.clearSelectionStruct();
    if (this.ex.ghostty_terminal_select_output(this.term, at.gridRef, at.sel) !== 0) return null;
    const start = this.screenCellOf(at.sel + S.start);
    const end = this.screenCellOf(at.sel + S.end);
    return start && end ? { start, end } : null;
  }

  selectionText(start: ScreenCell, end: ScreenCell): string {
    const ex = this.ex;
    const at = this.at;
    const S = this.L.selection;
    const F = S.format;
    this.info();
    // Rows that left history, or a selection made before a resize, are clamped.
    const last = this.sbRows + this._rows - 1;
    const clamp = (c: ScreenCell): ScreenCell => ({
      col: Math.max(0, Math.min(c.col, this._cols - 1)),
      row: Math.max(0, Math.min(c.row, last)),
    });
    this.clearSelectionStruct();
    if (!this.screenRef(clamp(start), at.sel + S.start)) return '';
    if (!this.screenRef(clamp(end), at.sel + S.end)) return '';
    this.u8().fill(0, at.selOpts, at.selOpts + F.size);
    const dv = this.dv();
    dv.setUint32(at.selOpts + F.sizeField, F.size, true);
    dv.setInt32(at.selOpts + F.emit, S.PLAIN, true);
    // Ghostty's copy: soft-wrapped rows joined, trailing whitespace trimmed.
    dv.setUint8(at.selOpts + F.unwrap, 1);
    dv.setUint8(at.selOpts + F.trim, 1);
    dv.setUint32(at.selOpts + F.selection, at.sel, true);
    dv.setUint32(at.outPtr, 0, true);
    dv.setUint32(at.outLen, 0, true);
    const rc = ex.ghostty_terminal_selection_format_alloc(
      this.term,
      0,
      at.selOpts,
      at.outPtr,
      at.outLen
    );
    const ptr = this.dv().getUint32(at.outPtr, true);
    const len = this.dv().getUint32(at.outLen, true);
    if (rc !== 0 || !ptr) return '';
    const text = new TextDecoder().decode(this.u8().slice(ptr, ptr + len));
    ex.ghostty_free(0, ptr, len);
    return text;
  }

  // ==========================================================================
  // Search (ADR 055)
  // ==========================================================================

  setSearch(needle: string): void {
    const ex = this.ex;
    const at = this.at;
    const S = this.L.search;
    if (!needle) {
      if (this.search) ex.ghostty_search_free(this.search);
      this.search = 0;
      if (this.matchBuf) ex.ghostty_wasm_free(this.matchBuf, this.matchCap * this.L.selection.size);
      this.matchBuf = 0;
      this.matchCap = 0;
      return;
    }
    if (!this.search) {
      this.search = this.vt.newHandle('search_new', (slot) =>
        ex.ghostty_search_new(0, slot, this.term)
      );
      // The view is webtty's own; Ghostty's viewport stays at the bottom
      this.dv().setInt32(at.u32, S.SCROLL_NONE, true);
      ex.ghostty_search_set(this.search, S.SELECT_SCROLL, at.u32);
    }
    const bytes = new TextEncoder().encode(needle);
    const buf = ex.ghostty_wasm_alloc(bytes.length);
    try {
      this.u8().set(bytes, buf);
      const dv = this.dv();
      dv.setUint32(at.str + this.L.string.ptr, buf, true);
      dv.setUint32(at.str + this.L.string.len, bytes.length, true);
      // An unchanged needle keeps its results
      ex.ghostty_search_set(this.search, S.NEEDLE, at.str);
    } finally {
      ex.ghostty_wasm_free(buf, bytes.length);
    }
    this.searchFedGen = 0;
  }

  searchStep(budgetMs: number): boolean {
    const ex = this.ex;
    const at = this.at;
    const S = this.L.search;
    if (!this.search) return false;
    let worked = false;
    // Feeding is the only way the search sees output, resizes and resets
    if (this.searchFedGen !== this.generation) {
      ex.ghostty_search_feed(this.search);
      this.searchFedGen = this.generation;
      worked = true;
    }
    if (ex.ghostty_search_get(this.search, S.STATUS, at.u32) !== 0) return worked;
    let status = this.dv().getInt32(at.u32, true);
    const end = performance.now() + budgetMs;
    while (status !== S.COMPLETE && performance.now() < end) {
      if (status === S.FEED_REQUIRED) ex.ghostty_search_feed(this.search);
      else ex.ghostty_search_tick(this.search, 0);
      if (ex.ghostty_search_get(this.search, S.STATUS, at.u32) !== 0) break;
      status = this.dv().getInt32(at.u32, true);
      worked = true;
    }
    return worked;
  }

  searchSelect(direction: 'next' | 'previous'): boolean {
    const S = this.L.search;
    if (!this.search) return false;
    const option = direction === 'next' ? S.SELECT_NEXT : S.SELECT_PREV;
    return this.ex.ghostty_search_set(this.search, option, 0) === 0;
  }

  searchState(): SearchState {
    const ex = this.ex;
    const at = this.at;
    const S = this.L.search;
    if (!this.search) return { total: 0, selected: null };
    const read = (data: number): number | null =>
      ex.ghostty_search_get(this.search, data, at.u32) === 0
        ? this.dv().getUint32(at.u32, true)
        : null;
    return { total: read(S.TOTAL_MATCHES) ?? 0, selected: read(S.SELECTED_INDEX) };
  }

  searchSelectedMatch(): ScreenRange | null {
    const at = this.at;
    const Sel = this.L.selection;
    if (!this.search) return null;
    this.clearSelectionStruct();
    if (this.ex.ghostty_search_get(this.search, this.L.search.SELECTED_MATCH, at.sel) !== 0) {
      return null;
    }
    const start = this.screenCellOf(at.sel + Sel.start);
    const end = this.screenCellOf(at.sel + Sel.end);
    return start && end ? { start, end } : null;
  }

  searchMatches(): Int32Array {
    const ex = this.ex;
    const at = this.at;
    const S = this.L.search;
    const Sel = this.L.selection;
    if (!this.search) return new Int32Array(0);
    // Matches are read where they are, before anything changes the terminal; the
    // buffer is grown to the count Ghostty reports, then read again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const dv = this.dv();
      dv.setUint32(at.searchBuf + S.ptr, this.matchBuf, true);
      dv.setUint32(at.searchBuf + S.cap, this.matchCap, true);
      dv.setUint32(at.searchBuf + S.len, 0, true);
      for (let i = 0; i < this.matchCap; i++) {
        dv.setUint32(this.matchBuf + i * Sel.size + Sel.sizeField, Sel.size, true);
      }
      const rc = ex.ghostty_search_get(this.search, S.MATCHES, at.searchBuf);
      const len = this.dv().getUint32(at.searchBuf + S.len, true);
      if (rc === this.L.result.OUT_OF_SPACE && attempt === 0) {
        if (this.matchBuf) ex.ghostty_wasm_free(this.matchBuf, this.matchCap * Sel.size);
        // Room for the matches output adds before the next read
        this.matchCap = len + (len >> 2) + 16;
        this.matchBuf = ex.ghostty_wasm_alloc(this.matchCap * Sel.size);
        if (!this.matchBuf) {
          this.matchCap = 0;
          return new Int32Array(0);
        }
        continue;
      }
      if (rc !== 0) return new Int32Array(0);
      const out = new Int32Array(len * 4);
      for (let i = 0; i < len; i++) {
        const sel = this.matchBuf + i * Sel.size;
        const start = this.screenCellOf(sel + Sel.start);
        const end = this.screenCellOf(sel + Sel.end);
        // A match that has no screen point (none expected) is left at row -1
        out[i * 4] = start?.col ?? 0;
        out[i * 4 + 1] = start?.row ?? -1;
        out[i * 4 + 2] = end?.col ?? 0;
        out[i * 4 + 3] = end?.row ?? -1;
      }
      return out;
    }
    return new Int32Array(0);
  }

  // ==========================================================================
  // Mouse reports (ADR 049)
  // ==========================================================================

  setMouseGeometry(geometry: MouseGeometry): void {
    const g = geometry;
    // Setting the size clears the encoder's last cell, so only a change is set.
    const key = [
      g.screenWidth,
      g.screenHeight,
      g.cellWidth,
      g.cellHeight,
      g.paddingTop,
      g.paddingRight,
      g.paddingBottom,
      g.paddingLeft,
    ].join(',');
    if (key === this.mouseGeometry) return;
    const enc = this.ensureMouseEncoder();
    const at = this.at;
    const M = this.L.mouse;
    const dv = this.dv();
    const u32 = (n: number) => Math.max(0, Math.round(n)) >>> 0;
    dv.setUint32(at.mouseSize + M.sizeField, M.size, true);
    dv.setUint32(at.mouseSize + M.screenWidth, u32(g.screenWidth), true);
    dv.setUint32(at.mouseSize + M.screenHeight, u32(g.screenHeight), true);
    // Ghostty ignores a zero cell size.
    dv.setUint32(at.mouseSize + M.cellWidth, Math.max(1, u32(g.cellWidth)), true);
    dv.setUint32(at.mouseSize + M.cellHeight, Math.max(1, u32(g.cellHeight)), true);
    dv.setUint32(at.mouseSize + M.paddingTop, u32(g.paddingTop), true);
    dv.setUint32(at.mouseSize + M.paddingRight, u32(g.paddingRight), true);
    dv.setUint32(at.mouseSize + M.paddingBottom, u32(g.paddingBottom), true);
    dv.setUint32(at.mouseSize + M.paddingLeft, u32(g.paddingLeft), true);
    this.ex.ghostty_mouse_encoder_setopt(enc, M.SIZE, at.mouseSize);
    this.mouseGeometry = key;
  }

  encodeMouse(input: MouseInput): Uint8Array {
    const ex = this.ex;
    const at = this.at;
    const M = this.L.mouse;
    const enc = this.ensureMouseEncoder();
    // The tracking mode and format, from the terminal. That call also clears the
    // encoder's last cell, so it is made only when a mouse mode changed: per-cell motion
    // deduplication would otherwise reset on every event.
    let modes = 0;
    MOUSE_MODES.forEach((mode, i) => {
      if (this.getMode(mode)) modes |= 1 << i;
    });
    if (modes !== this.mouseModes) {
      ex.ghostty_mouse_encoder_setopt_from_terminal(enc, this.term);
      this.mouseModes = modes;
    }
    this.u8()[at.u8] = input.anyButtonPressed ? 1 : 0;
    ex.ghostty_mouse_encoder_setopt(enc, M.ANY_BUTTON_PRESSED, at.u8);
    const ev = this.mouseEvent;
    ex.ghostty_mouse_event_set_action(ev, M.action[input.action]);
    if (input.button) ex.ghostty_mouse_event_set_button(ev, M.button[input.button]);
    else ex.ghostty_mouse_event_clear_button(ev);
    ex.ghostty_mouse_event_set_mods(ev, input.mods);
    const dv = this.dv();
    dv.setFloat32(at.mousePos + M.x, input.x, true);
    dv.setFloat32(at.mousePos + M.y, input.y, true);
    ex.ghostty_mouse_event_set_position(ev, at.mousePos);
    const rc = ex.ghostty_mouse_encoder_encode(enc, ev, at.mouseOut, MOUSE_REPORT_MAX, at.u32);
    if (rc !== 0) return new Uint8Array(0);
    const n = this.dv().getUint32(at.u32, true);
    return this.u8().slice(at.mouseOut, at.mouseOut + n);
  }

  /** The mouse encoder, made with per-cell motion deduplication on, and its event. */
  private ensureMouseEncoder(): number {
    if (this.mouseEncoder) return this.mouseEncoder;
    const ex = this.ex;
    const vt = this.vt;
    this.mouseEncoder = vt.newHandle('mouse_encoder_new', (slot) =>
      ex.ghostty_mouse_encoder_new(0, slot)
    );
    this.mouseEvent = vt.newHandle('mouse_event_new', (slot) =>
      ex.ghostty_mouse_event_new(0, slot)
    );
    this.u8()[this.at.u8] = 1;
    ex.ghostty_mouse_encoder_setopt(this.mouseEncoder, this.L.mouse.TRACK_LAST_CELL, this.at.u8);
    return this.mouseEncoder;
  }

  // ==========================================================================
  // Focus reports (ADR 053)
  // ==========================================================================

  encodeFocus(focused: boolean): Uint8Array {
    const at = this.at;
    const F = this.L.focus;
    const event = focused ? F.GAINED : F.LOST;
    const rc = this.ex.ghostty_focus_encode(event, at.focusOut, FOCUS_REPORT_MAX, at.u32);
    if (rc !== 0) return new Uint8Array(0);
    const n = this.dv().getUint32(at.u32, true);
    return this.u8().slice(at.focusOut, at.focusOut + n);
  }

  // ==========================================================================
  // Paste (ADR 049)
  // ==========================================================================

  paste(text: string): void {
    const ex = this.ex;
    const P = this.L.paste;
    const S = this.L.string;
    const bytes = new TextEncoder().encode(text);
    const mime = new TextEncoder().encode('text/plain');
    // One allocation: the paste struct, the one-entry mime array, the mime and the text.
    const mimesAt = Math.ceil(P.size / 8) * 8;
    const mimeAt = mimesAt + S.size;
    const textAt = mimeAt + mime.length;
    const len = textAt + bytes.length;
    const base = ex.ghostty_wasm_alloc(len);
    if (!base) throw new Error('libghostty-vt: out of memory');
    try {
      const u8 = this.u8();
      u8.fill(0, base, base + P.size);
      u8.set(mime, base + mimeAt);
      u8.set(bytes, base + textAt);
      const dv = this.dv();
      dv.setUint32(base + mimesAt + S.ptr, base + mimeAt, true);
      dv.setUint32(base + mimesAt + S.len, mime.length, true);
      dv.setUint32(base + P.sizeField, P.size, true);
      dv.setInt32(base + P.location, P.STANDARD, true);
      dv.setInt32(base + P.source, P.CLIPBOARD, true);
      dv.setUint32(base + P.mimes, base + mimesAt, true);
      dv.setUint32(base + P.mimesLen, 1, true);
      dv.setUint32(base + P.reader + P.readerRead, this.ensurePasteReader(), true);
      // Text that could run commands (a newline without 2004) is sent, never refused:
      // ADR 037, and webtty has no confirmation dialog.
      dv.setUint8(base + P.allowUnsafe, 1);
      this.pasteText = { ptr: base + textAt, len: bytes.length };
      const rc = ex.ghostty_terminal_paste(this.term, base, 0);
      if (rc !== 0) throw new Error(`libghostty-vt terminal_paste failed: ${rc}`);
    } finally {
      this.pasteText = { ptr: 0, len: 0 };
      ex.ghostty_wasm_free(base, len);
    }
  }

  /**
   * The GhosttyMimeReader callback: `(userdata, mime, writer)`, the GhosttyString and
   * GhosttyWriter structs passed by pointer on wasm32. It writes the text of the paste in
   * progress through the writer, a function in the wasm's table, and returns its result.
   */
  private ensurePasteReader(): number {
    if (this.pasteReader) return this.pasteReader;
    const P = this.L.paste;
    const table = this.ex.__indirect_function_table;
    const installed = this.vt.fnTable.install(
      ((_userdata: number, _mime: number, writer: number) => {
        const { ptr, len } = this.pasteText;
        if (len === 0) return 1;
        const dv = this.dv();
        const write = table.get(dv.getUint32(writer + P.writerWrite, true)) as (
          userdata: number,
          data: number,
          len: number
        ) => number;
        return write(dv.getUint32(writer + P.writerUserdata, true), ptr, len) ? 1 : 0;
      }) as (...args: number[]) => number,
      [I32, I32, I32],
      [I32]
    );
    this.callbacks.push(installed);
    this.pasteReader = installed.index;
    return this.pasteReader;
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
    const effects = {
      bell: this.bell,
      title: this.pendingTitle,
      clipboard: this.pendingClipboard,
      notifications: this.pendingNotifications,
    };
    this.bell = false;
    this.pendingTitle = null;
    this.pendingClipboard = null;
    this.pendingNotifications = [];
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

  /**
   * Puts Ghostty's mode 12 bit, which its render state reports as the cursor blink,
   * back to the blink DECSCUSR set. Ghostty with `cursor-style-blink` set ignores mode
   * 12 (`setMode` in its `termio/stream_handler.zig`), and webtty's `cursorStyleBlink`
   * is always set, so a program's `CSI ? 12 l` (vim's `t_ve`) no longer stops the
   * blink for good. (webtty, ADR 049)
   */
  private syncBlink(): void {
    if (this.getMode(MODE_CURSOR_BLINK) === this.blink) return;
    const at = this.at;
    const M = this.L.mode;
    const dv = this.dv();
    dv.setUint16(at.mode + M.mode, MODE_CURSOR_BLINK, true);
    dv.setUint8(at.mode + M.value, this.blink ? 1 : 0);
    this.setOption(this.L.opt.MODE, at.mode, 'MODE 12');
  }

  private setOption(option: number, value: number, what: string): void {
    const rc = this.ex.ghostty_terminal_set(this.term, option, value);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_set ${what} failed: ${rc}`);
  }

  private scrollViewport(tag: number, value: number): void {
    const at = this.at;
    const S = this.L.scroll;
    const u8 = this.u8();
    u8.fill(0, at.scroll, at.scroll + S.size);
    const dv = this.dv();
    dv.setInt32(at.scroll + S.tag, tag, true);
    // The ROW arm is a usize and DELTA_PROMPT an isize (32 bits on wasm32); the union is
    // zeroed above.
    dv.setInt32(at.scroll + S.value, value, true);
    this.ex.ghostty_terminal_scroll_viewport(this.term, at.scroll);
  }

  // ==========================================================================
  // Private: setup
  // ==========================================================================

  private installCallbacks(clipboardWrite: boolean, desktopNotifications: boolean): void {
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
    // DEVICE_ATTRIBUTES: ESC[?62;22c and ESC[>1;10;0c, the replies webtty gave on
    // the Coder wasm (without it, Ghostty's secondary DA is ESC[>1;0;0c).
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
    // CLIPBOARD_WRITE(terminal, userdata, write): left NULL with clipboardWrite off, so
    // Ghostty ignores OSC 52 and OSC 1337 Copy and refuses OSC 5522 writes (ADR 052).
    if (clipboardWrite) {
      install(
        L.opt.CLIPBOARD_WRITE,
        'CLIPBOARD_WRITE',
        (_t, _u, write) => {
          this.clipboardWrite(write);
          return undefined;
        },
        3,
        false
      );
    }
    // DESKTOP_NOTIFICATION(terminal, userdata, notification): OSC 9 (but not ConEmu's
    // OSC 9;<n> forms, which Ghostty's parser takes first) and OSC 777;notify. The
    // strings are borrowed, so they are copied out here. Left NULL with
    // desktopNotifications off, so Ghostty ignores them (webtty, ADR 056).
    if (desktopNotifications) {
      install(
        L.opt.DESKTOP_NOTIFICATION,
        'DESKTOP_NOTIFICATION',
        (_t, _u, notification) => {
          const N = this.L.notification;
          // A sized struct: read only the fields its size covers.
          if (this.dv().getUint32(notification + N.size, true) < N.bodyEnd) return undefined;
          const text = (ptr: number) => new TextDecoder().decode(this.stringAt(ptr));
          this.pendingNotifications.push({
            title: text(notification + N.title),
            body: text(notification + N.body),
          });
          return undefined;
        },
        3,
        false
      );
    }
  }

  /**
   * Takes one clipboard write (`GhosttyClipboardWrite`, already base64-decoded by
   * Ghostty) and answers it before returning, as the API requires. Only the standard
   * clipboard is written: the browser has no other, and Ghostty on macOS keeps `s` in
   * a private pasteboard and drops `p`. The text is the first plain-text
   * representation, decoded as UTF-8 with invalid bytes replaced (U+FFFD); no
   * representations is a clear, kept as `''`. The browser write happens later, after
   * `readEffects`, so success here means the write was accepted. (webtty, ADR 052)
   */
  private clipboardWrite(write: number): void {
    const C = this.L.clipboardWrite;
    const dv = this.dv();
    let result = C.UNSUPPORTED;
    if (dv.getInt32(write + C.location, true) === C.STANDARD) {
      const contents = dv.getUint32(write + C.contents, true);
      const count = dv.getUint32(write + C.contentsLen, true);
      if (count === 0) {
        this.pendingClipboard = '';
        result = C.SUCCESS;
      }
      for (let i = 0; i < count; i++) {
        const content = contents + i * C.contentSize;
        const mime = this.stringAt(content + C.mime);
        if (!isTextMime(new TextDecoder().decode(mime))) continue;
        this.pendingClipboard = new TextDecoder().decode(this.stringAt(content + C.data));
        result = C.SUCCESS;
        break;
      }
    }
    const reply = this.at.clipReply;
    const out = this.dv();
    new Uint8Array(this.ex.memory.buffer, reply, C.replySize).fill(0);
    out.setUint32(reply + C.replySizeField, C.replySize, true);
    out.setInt32(reply + C.replyResult, result, true);
    const fn = this.ex.__indirect_function_table.get(out.getUint32(write + C.reply, true)) as (
      write: number,
      reply: number
    ) => void;
    fn(write, reply);
  }

  /** A copy of the bytes a `GhosttyString` at `ptr` points to. */
  private stringAt(ptr: number): Uint8Array {
    const S = this.L.string;
    const dv = this.dv();
    const data = dv.getUint32(ptr + S.ptr, true);
    const len = dv.getUint32(ptr + S.len, true);
    return len === 0 ? new Uint8Array(0) : this.u8().slice(data, data + len);
  }

  private applyConfig(config: GhosttyTerminalConfig | undefined): void {
    const L = this.L;
    const at = this.at;

    // Scrollback in lines under a 32 MiB ceiling (ADR 046). Whichever limit is reached
    // first applies. 0 bytes would disable scrollback and a NULL byte limit would
    // remove the ceiling, so neither is ever passed; NULL lines removes the line limit.
    const lines = config?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    this.dv().setUint32(at.u32, SCROLLBACK_CEILING_BYTES, true);
    this.setOption(L.opt.SCROLLBACK_MAX_BYTES, at.u32, 'SCROLLBACK_MAX_BYTES');
    if (lines > 0) this.dv().setUint32(at.u32, lines, true);
    this.setOption(L.opt.SCROLLBACK_MAX_LINES, lines > 0 ? at.u32 : 0, 'SCROLLBACK_MAX_LINES');

    // Grapheme clustering (mode 2027) on by default, so RIS keeps it.
    const dv = this.dv();
    dv.setUint16(at.mode + L.mode.mode, 2027, true);
    dv.setUint8(at.mode + L.mode.value, 1);
    this.setOption(L.opt.MODE_DEFAULT, at.mode, 'MODE_DEFAULT 2027');

    // The configured cursor, which DECSCUSR Ps 0 and RIS restore (ADR 049).
    this.setDefaultCursor(config?.cursorStyle ?? 'block', config?.cursorBlink ?? false);

    const setColor = (option: number, value: number, what: string) => {
      this.writeRgb(at.u32, value);
      this.setOption(option, at.u32, what);
    };
    // Foreground and background are always both set: Ghostty's render state copies
    // the default colours only when both are set (render.zig `bg_fg`), otherwise it
    // keeps white on black and ignores the given colour, OSC 10/11 and DECSCNM.
    // An unset one falls back to webtty's default.
    setColor(
      L.opt.COLOR_FOREGROUND,
      config?.fgColor ?? FALLBACK_FOREGROUND,
      'COLOR_FOREGROUND'
    );
    setColor(
      L.opt.COLOR_BACKGROUND,
      config?.bgColor ?? FALLBACK_BACKGROUND,
      'COLOR_BACKGROUND'
    );
    if (!config) return;
    if (config.cursorColor !== undefined) {
      setColor(L.opt.COLOR_CURSOR, config.cursorColor, 'COLOR_CURSOR');
    }
    const palette = config.palette ?? [];
    const entries = palette
      .map((value, i) => ({ value, i }))
      .filter((e): e is { value: number; i: number } => e.i < 16 && e.value !== undefined);
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

  // ==========================================================================
  // Private: single-cell lookups (grid_ref)
  // ==========================================================================

  /** Resolves a point to a grid reference at `out` (by default `at.gridRef`). */
  private gridRef(tag: number, x: number, y: number, out: number = this.at.gridRef): boolean {
    const L = this.L;
    const at = this.at;
    const P = L.point;
    this.u8().fill(0, at.point, at.point + P.size);
    const dv = this.dv();
    dv.setInt32(at.point + P.tag, tag, true);
    dv.setUint16(at.point + P.value + P.x, x, true);
    dv.setUint32(at.point + P.value + P.y, y, true);
    this.u8().fill(0, out, out + L.gridRef.size);
    dv.setUint32(out + L.gridRef.sizeField, L.gridRef.size, true);
    return this.ex.ghostty_terminal_grid_ref(this.term, at.point, out) === 0;
  }

  // ==========================================================================
  // Private: selection (ADR 050)
  // ==========================================================================

  private screenRef(cell: ScreenCell, out: number): boolean {
    if (cell.col < 0 || cell.col >= this._cols || cell.row < 0) return false;
    return this.gridRef(this.L.point.SCREEN, cell.col, cell.row, out);
  }

  /** The screen cell of the grid reference at `ref`, or null if it has none. */
  private screenCellOf(ref: number): ScreenCell | null {
    const at = this.at;
    const P = this.L.point;
    const rc = this.ex.ghostty_terminal_point_from_grid_ref(this.term, ref, P.SCREEN, at.coord);
    if (rc !== 0) return null;
    const dv = this.dv();
    return { col: dv.getUint16(at.coord + P.x, true), row: dv.getUint32(at.coord + P.y, true) };
  }

  /** Zeroes the GhosttySelection at `at.sel` and sets its size field. */
  private clearSelectionStruct(): void {
    const S = this.L.selection;
    this.u8().fill(0, this.at.sel, this.at.sel + S.size);
    this.dv().setUint32(this.at.sel + S.sizeField, S.size, true);
  }

  /**
   * Runs a `select_*` call whose options are a sized struct with one grid reference,
   * set to `cell`, and returns the selection it derives in screen cells.
   */
  private selectAt(
    options: { size: number; sizeField: number; ref: number },
    cell: ScreenCell,
    call: (options: number, outSelection: number) => number
  ): ScreenRange | null {
    const at = this.at;
    const S = this.L.selection;
    this.info();
    this.u8().fill(0, at.selOpts, at.selOpts + options.size);
    this.dv().setUint32(at.selOpts + options.sizeField, options.size, true);
    if (!this.screenRef(cell, at.selOpts + options.ref)) return null;
    this.clearSelectionStruct();
    if (call(at.selOpts, at.sel) !== 0) return null;
    const start = this.screenCellOf(at.sel + S.start);
    const end = this.screenCellOf(at.sel + S.end);
    return start && end ? { start, end } : null;
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
