// webtty (ADR 042, ADR 047, ADR 061), not from upstream.
// The terminal on the official libghostty-vt wasm (facade): `OfficialTerminal` implements
// the `GhosttyTerminal` interface the rest of the vendored layer uses, on the wasm instance
// (`EngineHost`) that `Ghostty.createTerminal` passes it. Moved whole out of ghostty.ts (ADR 061);
// its parts share one `EngineContext`: the render state and the scrollback pages so far.

import { type InstalledFn, WasmValType } from '../fn-table';
import { DirtyState, type GhosttyCell, type RenderStateCursor } from './cell-types';
import { scanCursorBlink } from './cursor-blink';
import { EngineContext } from './engine-context';
import type {
  DesktopNotification,
  EngineHost,
  GhosttyTerminal,
  GhosttyTerminalConfig,
  MouseGeometry,
  MouseInput,
  ScreenCell,
  ScreenRange,
  SearchState,
  TerminalEffects,
} from './engine-types';
import { isKittyKeyboardReply } from './kitty-keyboard-reply';
import type { OfficialLayout } from './official-layout';
import { RenderState, type RenderStateSlot, renderStateSlots } from './render-state';
import { copyRow, graphemeOf } from './row-ref';
import { ScrollbackPages } from './scrollback-pages';
import { isTextMime } from './text-mime';
import type { OfficialWasmExports } from './wasm-exports';

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

const I32 = WasmValType.I32;
/** The scrollback byte ceiling under the line limit (ADR 046). */
const SCROLLBACK_CEILING_BYTES = 32 * 1024 * 1024;
/** History in lines when the config gives none (ADR 046, ADR 047). */
const DEFAULT_SCROLLBACK_LINES = 10000;
/** webtty's default colours, used when the theme leaves one unset. */
const FALLBACK_FOREGROUND = 0xcccccc;
const FALLBACK_BACKGROUND = 0x000000;
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

/** The scratch slots of the parts still in the facade, until they become bindings (ADR 061). */
function terminalSlots(L: OfficialLayout) {
  return {
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
    scrollbar: [L.scrollbar.size, 8],
    palette: [256 * L.colors.rgbSize, 8],
    mouseSize: [L.mouse.size, 8],
    mousePos: [L.mouse.positionSize, 8],
    mouseOut: [MOUSE_REPORT_MAX, 8],
    focusOut: [FOCUS_REPORT_MAX, 8],
    clipReply: [L.clipboardWrite.replySize, 8],
    searchBuf: [L.search.bufferSize, 8],
  } as const;
}

type TerminalSlot = keyof ReturnType<typeof terminalSlots>;

/**
 * A terminal on the official libghostty-vt wasm (ADR 042).
 *
 * Rows are read through `RenderState`, which keeps a JS copy of the active screen up to
 * date once per generation, and `ScrollbackPages`, which reads scrollback a page at a
 * time and caches it until the content changes, so scrolling only records the offset
 * and serves rows from the copy and the cache. The other wasm objects (selection,
 * search, mouse and paste encoders, callbacks) are still driven from here.
 */
export class OfficialTerminal implements GhosttyTerminal {
  private readonly vt: EngineHost;
  private readonly ctx: EngineContext<TerminalSlot | RenderStateSlot>;
  private readonly ex: OfficialWasmExports;
  private readonly L: OfficialLayout;
  private readonly at: EngineContext<TerminalSlot | RenderStateSlot>['at'];
  private readonly render: RenderState;
  private readonly pages: ScrollbackPages;
  private readonly callbacks: InstalledFn[] = [];
  private cellWidthPx = 0;
  private cellHeightPx = 0;

  // The blink DECSCUSR set, or the default while it has not set one; DEC mode 12 is
  // ignored, so Ghostty's mode bit is put back to it after every write (ADR 049).
  private blinkDefault = false;
  private blinkIsDefault = true;
  private blink = false;
  private blinkCarry = '';

  // The view's offset: lines scrolled up from the bottom. Ghostty's viewport stays at
  // the bottom; only page reads move it, and they move it back.
  private offset = 0;

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

  constructor(vt: EngineHost, cols: number, rows: number, config?: GhosttyTerminalConfig) {
    this.vt = vt;
    this.ex = vt.ex;
    this.L = vt.L;
    this.ctx = new EngineContext(vt, cols, rows, {
      ...renderStateSlots(vt.L),
      ...terminalSlots(vt.L),
    });
    this.at = this.ctx.at;
    this.render = new RenderState(this.ctx);
    this.pages = new ScrollbackPages(this.ctx, this.render);

    this.installCallbacks(
      config?.clipboardWrite ?? true,
      config?.desktopNotifications ?? true
    );
    this.applyConfig(config);
  }

  get cols(): number {
    return this.ctx.cols;
  }

  get rows(): number {
    return this.ctx.rows;
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
      this.render.markAllDirty();
    }
    const ex = this.ex;
    let consumed: number | null = bytes.length;
    // until_ground takes NULL for no bytes, and then only says whether it is at ground
    const ptr = bytes.length > 0 ? ex.ghostty_wasm_alloc(bytes.length) : 0;
    if (bytes.length > 0 && !ptr) throw new Error('libghostty-vt: out of memory');
    if (ptr) this.ctx.u8().set(bytes, ptr);
    if (untilGround) {
      const rc = ex.ghostty_terminal_vt_write_until_ground(this.ctx.term, ptr, bytes.length, this.at.u32);
      consumed = rc === this.L.result.SUCCESS ? this.ctx.dv().getUint32(this.at.u32, true) : null;
    } else if (ptr) {
      ex.ghostty_terminal_vt_write(this.ctx.term, ptr, bytes.length);
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
    this.ctx.generation++;
    if (this.titleChanged) this.readTitle();
    return consumed;
  }

  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): void {
    if (cols === this.ctx.cols && rows === this.ctx.rows) {
      if (cellWidthPx !== undefined && cellHeightPx !== undefined) {
        this.setCellPixelSize(cellWidthPx, cellHeightPx);
      }
      return;
    }
    this.ctx.cols = cols;
    this.ctx.rows = rows;
    if (cellWidthPx !== undefined && cellHeightPx !== undefined) {
      this.cellWidthPx = Math.max(0, Math.round(cellWidthPx));
      this.cellHeightPx = Math.max(0, Math.round(cellHeightPx));
    }
    // One call per real change: with mode 2048 on, every call sends a size report.
    const rc = this.ex.ghostty_terminal_resize(
      this.ctx.term,
      cols,
      rows,
      this.cellWidthPx,
      this.cellHeightPx
    );
    if (rc !== 0) throw new Error(`libghostty-vt terminal_resize failed: ${rc}`);
    this.ctx.generation++;
    this.render.resized();
    // Reflow keeps Ghostty's viewport at the bottom; only the offset is clamped.
    if (this.offset > 0) this.setViewportOffset(this.offset);
  }

  setCellPixelSize(cellWidthPx: number, cellHeightPx: number): void {
    const w = Math.max(0, Math.round(cellWidthPx));
    const h = Math.max(0, Math.round(cellHeightPx));
    if (w === this.cellWidthPx && h === this.cellHeightPx) return;
    this.cellWidthPx = w;
    this.cellHeightPx = h;
    const rc = this.ex.ghostty_terminal_resize(this.ctx.term, this.ctx.cols, this.ctx.rows, w, h);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_resize failed: ${rc}`);
    this.ctx.generation++;
  }

  setDefaultCursor(style: RenderStateCursor['style'], blink: boolean): void {
    const L = this.L;
    const at = this.at;
    this.ctx.dv().setInt32(at.u32, L.defaultCursorStyle[style], true);
    this.ctx.setOption(L.opt.DEFAULT_CURSOR_STYLE, at.u32, 'DEFAULT_CURSOR_STYLE');
    this.ctx.u8()[at.u8] = blink ? 1 : 0;
    this.ctx.setOption(L.opt.DEFAULT_CURSOR_BLINK, at.u8, 'DEFAULT_CURSOR_BLINK');
    this.blinkDefault = blink;
    if (this.blinkIsDefault) this.blink = blink;
    this.syncBlink();
    // The cursor is read from the render state, which only a content change refreshes.
    this.ctx.generation++;
  }

  /**
   * Records the view's offset. Ghostty's viewport is not moved and nothing is
   * decoded: rows above the active screen come from the page cache, and the active
   * rows from the primary copy, so a scroll step costs no export call on a page hit.
   */
  setViewportOffset(linesFromBottom: number): void {
    this.ctx.info();
    const k = this.ctx.altScreen
      ? 0
      : Math.max(0, Math.min(Math.floor(linesFromBottom) || 0, this.ctx.sbRows));
    if (k === this.offset) return;
    // Scrolling changes no row: the renderer repaints what the move needs (ADR 043).
    this.offset = k;
  }

  free(): void {
    const ex = this.ex;
    if (!this.ctx.term) return;
    this.setSearch('');
    ex.ghostty_terminal_free(this.ctx.term);
    this.ctx.term = 0;
    // Slots are released only after nothing can call them (fn-table.ts rule 3).
    for (const fn of this.callbacks) fn.release();
    this.callbacks.length = 0;
    if (this.mouseEncoder) ex.ghostty_mouse_encoder_free(this.mouseEncoder);
    if (this.mouseEvent) ex.ghostty_mouse_event_free(this.mouseEvent);
    this.mouseEncoder = 0;
    this.mouseEvent = 0;
    this.pages.free();
    this.render.free();
    this.ctx.scratch.free();
  }

  // ==========================================================================
  // Render state
  // ==========================================================================

  update(): DirtyState {
    return this.render.update();
  }

  getCursor(): RenderStateCursor {
    return this.render.getCursor();
  }

  isRowDirty(y: number): boolean {
    return this.render.isRowDirty(y);
  }

  markClean(): void {
    this.render.markClean();
  }

  getViewport(): GhosttyCell[] {
    // The active screen, scrolled or not.
    return this.render.getViewport();
  }

  getLine(y: number): GhosttyCell[] | null {
    if (y < 0 || y >= this.ctx.rows) return null;
    this.render.refresh();
    return copyRow(this.pages.rowAt(this.ctx.sbRows + y), this.ctx.cols);
  }

  needsFullRedraw(): boolean {
    return this.update() === DirtyState.FULL;
  }

  clearDirty(): void {
    this.markClean();
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.ctx.cols, rows: this.ctx.rows };
  }

  // ==========================================================================
  // Modes
  // ==========================================================================

  isAlternateScreen(): boolean {
    this.ctx.info();
    return this.ctx.altScreen;
  }

  hasMouseTracking(): boolean {
    const at = this.at;
    const rc = this.ex.ghostty_terminal_get(this.ctx.term, this.L.tdata.MOUSE_TRACKING, at.u8);
    return rc === 0 && this.ctx.u8()[at.u8] !== 0;
  }

  cursorAtPrompt(): boolean {
    const at = this.at;
    const rc = this.ex.ghostty_terminal_get(this.ctx.term, this.L.tdata.CURSOR_AT_PROMPT, at.u8);
    return rc === 0 && this.ctx.u8()[at.u8] !== 0;
  }

  promptJumpRow(top: number, delta: number): number {
    const at = this.at;
    const S = this.L.scroll;
    this.ctx.info();
    // Ghostty moves its viewport from its top row, so it is put on webtty's for the move
    this.ctx.scrollViewport(S.ROW, top);
    try {
      this.ctx.scrollViewport(S.DELTA_PROMPT, delta);
      const rc = this.ex.ghostty_terminal_get(this.ctx.term, this.L.tdata.SCROLLBAR, at.scrollbar);
      if (rc !== 0) return top;
      // The offset is a u64; a screen row fits in the low 32 bits
      return this.ctx.dv().getUint32(at.scrollbar + this.L.scrollbar.offset, true);
    } finally {
      this.ctx.scrollViewport(S.BOTTOM, 0);
    }
  }

  getMode(mode: number, isAnsi: boolean = false): boolean {
    const at = this.at;
    const M = this.L.mode;
    const dv = this.ctx.dv();
    // GhosttyMode (modes.h ghostty_mode_new): number in bits 0-14, bit 15 = ANSI.
    dv.setUint16(at.mode + M.mode, (mode & 0x7fff) | (isAnsi ? 0x8000 : 0), true);
    dv.setUint8(at.mode + M.value, 0);
    const rc = this.ex.ghostty_terminal_get(this.ctx.term, this.L.tdata.MODE, at.mode);
    return rc === 0 && this.ctx.u8()[at.mode + M.value] !== 0;
  }

  // ==========================================================================
  // Scrollback, graphemes, hyperlinks
  // ==========================================================================

  getScrollbackLength(): number {
    this.ctx.info();
    return this.ctx.sbRows;
  }

  getScrollbackLine(offset: number): GhosttyCell[] | null {
    this.render.refresh();
    if (offset < 0 || offset >= this.ctx.sbRows) return null;
    // A page's cells are never written after the page is read, so the row's cell
    // objects are shared, not copied; only the array is new.
    return this.pages.scrollbackRow(offset).cells.slice();
  }

  isRowWrapped(row: number): boolean {
    if (row < 0 || row >= this.ctx.rows) return false;
    const at = this.at;
    if (!this.gridRef(this.L.point.ACTIVE, 0, row)) return false;
    if (this.ex.ghostty_grid_ref_row(at.gridRef, at.row64) !== 0) return false;
    const rowValue = this.ctx.dv().getBigUint64(at.row64, true);
    if (this.ex.ghostty_row_get(rowValue, this.L.rowWrapContinuation, at.u8) !== 0) return false;
    return this.ctx.u8()[at.u8] !== 0;
  }

  getHyperlinkUri(row: number, col: number): string | null {
    if (row < 0 || row >= this.ctx.rows) return null;
    return this.hyperlinkAt(this.L.point.ACTIVE, col, row);
  }

  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.hyperlinkAt(this.L.point.HISTORY, col, offset);
  }

  getGraphemeString(row: number, col: number): string {
    if (row < 0 || row >= this.ctx.rows || col < 0 || col >= this.ctx.cols) return ' ';
    this.render.refresh();
    return graphemeOf(this.pages.rowAt(this.ctx.sbRows + row), col);
  }

  getScrollbackGraphemeString(offset: number, col: number): string {
    this.render.refresh();
    if (offset < 0 || offset >= this.ctx.sbRows || col < 0 || col >= this.ctx.cols) return ' ';
    return graphemeOf(this.pages.rowAt(offset), col);
  }

  // ==========================================================================
  // Selection (ADR 050)
  // ==========================================================================

  selectWord(cell: ScreenCell): ScreenRange | null {
    const W = this.L.selection.word;
    return this.selectAt(W, cell, (opts, out) =>
      this.ex.ghostty_terminal_select_word(this.ctx.term, opts, out)
    );
  }

  selectLine(cell: ScreenCell): ScreenRange | null {
    const W = this.L.selection.line;
    return this.selectAt(W, cell, (opts, out) =>
      this.ex.ghostty_terminal_select_line(this.ctx.term, opts, out)
    );
  }

  selectOutput(cell: ScreenCell): ScreenRange | null {
    const at = this.at;
    const S = this.L.selection;
    this.ctx.info();
    if (!this.screenRef(cell, at.gridRef)) return null;
    this.clearSelectionStruct();
    if (this.ex.ghostty_terminal_select_output(this.ctx.term, at.gridRef, at.sel) !== 0) return null;
    const start = this.screenCellOf(at.sel + S.start);
    const end = this.screenCellOf(at.sel + S.end);
    return start && end ? { start, end } : null;
  }

  selectionText(start: ScreenCell, end: ScreenCell): string {
    const ex = this.ex;
    const at = this.at;
    const S = this.L.selection;
    const F = S.format;
    this.ctx.info();
    // Rows that left history, or a selection made before a resize, are clamped.
    const last = this.ctx.sbRows + this.ctx.rows - 1;
    const clamp = (c: ScreenCell): ScreenCell => ({
      col: Math.max(0, Math.min(c.col, this.ctx.cols - 1)),
      row: Math.max(0, Math.min(c.row, last)),
    });
    this.clearSelectionStruct();
    if (!this.screenRef(clamp(start), at.sel + S.start)) return '';
    if (!this.screenRef(clamp(end), at.sel + S.end)) return '';
    this.ctx.u8().fill(0, at.selOpts, at.selOpts + F.size);
    const dv = this.ctx.dv();
    dv.setUint32(at.selOpts + F.sizeField, F.size, true);
    dv.setInt32(at.selOpts + F.emit, S.PLAIN, true);
    // Ghostty's copy: soft-wrapped rows joined, trailing whitespace trimmed.
    dv.setUint8(at.selOpts + F.unwrap, 1);
    dv.setUint8(at.selOpts + F.trim, 1);
    dv.setUint32(at.selOpts + F.selection, at.sel, true);
    dv.setUint32(at.outPtr, 0, true);
    dv.setUint32(at.outLen, 0, true);
    const rc = ex.ghostty_terminal_selection_format_alloc(
      this.ctx.term,
      0,
      at.selOpts,
      at.outPtr,
      at.outLen
    );
    const ptr = this.ctx.dv().getUint32(at.outPtr, true);
    const len = this.ctx.dv().getUint32(at.outLen, true);
    if (rc !== 0 || !ptr) return '';
    const text = new TextDecoder().decode(this.ctx.u8().slice(ptr, ptr + len));
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
        ex.ghostty_search_new(0, slot, this.ctx.term)
      );
      // The view is webtty's own; Ghostty's viewport stays at the bottom
      this.ctx.dv().setInt32(at.u32, S.SCROLL_NONE, true);
      ex.ghostty_search_set(this.search, S.SELECT_SCROLL, at.u32);
    }
    const bytes = new TextEncoder().encode(needle);
    const buf = ex.ghostty_wasm_alloc(bytes.length);
    try {
      this.ctx.u8().set(bytes, buf);
      const dv = this.ctx.dv();
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
    if (this.searchFedGen !== this.ctx.generation) {
      ex.ghostty_search_feed(this.search);
      this.searchFedGen = this.ctx.generation;
      worked = true;
    }
    if (ex.ghostty_search_get(this.search, S.STATUS, at.u32) !== 0) return worked;
    let status = this.ctx.dv().getInt32(at.u32, true);
    const end = performance.now() + budgetMs;
    while (status !== S.COMPLETE && performance.now() < end) {
      if (status === S.FEED_REQUIRED) ex.ghostty_search_feed(this.search);
      else ex.ghostty_search_tick(this.search, 0);
      if (ex.ghostty_search_get(this.search, S.STATUS, at.u32) !== 0) break;
      status = this.ctx.dv().getInt32(at.u32, true);
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
        ? this.ctx.dv().getUint32(at.u32, true)
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
      const dv = this.ctx.dv();
      dv.setUint32(at.searchBuf + S.ptr, this.matchBuf, true);
      dv.setUint32(at.searchBuf + S.cap, this.matchCap, true);
      dv.setUint32(at.searchBuf + S.len, 0, true);
      for (let i = 0; i < this.matchCap; i++) {
        dv.setUint32(this.matchBuf + i * Sel.size + Sel.sizeField, Sel.size, true);
      }
      const rc = ex.ghostty_search_get(this.search, S.MATCHES, at.searchBuf);
      const len = this.ctx.dv().getUint32(at.searchBuf + S.len, true);
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
    const dv = this.ctx.dv();
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
      ex.ghostty_mouse_encoder_setopt_from_terminal(enc, this.ctx.term);
      this.mouseModes = modes;
    }
    this.ctx.u8()[at.u8] = input.anyButtonPressed ? 1 : 0;
    ex.ghostty_mouse_encoder_setopt(enc, M.ANY_BUTTON_PRESSED, at.u8);
    const ev = this.mouseEvent;
    ex.ghostty_mouse_event_set_action(ev, M.action[input.action]);
    if (input.button) ex.ghostty_mouse_event_set_button(ev, M.button[input.button]);
    else ex.ghostty_mouse_event_clear_button(ev);
    ex.ghostty_mouse_event_set_mods(ev, input.mods);
    const dv = this.ctx.dv();
    dv.setFloat32(at.mousePos + M.x, input.x, true);
    dv.setFloat32(at.mousePos + M.y, input.y, true);
    ex.ghostty_mouse_event_set_position(ev, at.mousePos);
    const rc = ex.ghostty_mouse_encoder_encode(enc, ev, at.mouseOut, MOUSE_REPORT_MAX, at.u32);
    if (rc !== 0) return new Uint8Array(0);
    const n = this.ctx.dv().getUint32(at.u32, true);
    return this.ctx.u8().slice(at.mouseOut, at.mouseOut + n);
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
    this.ctx.u8()[this.at.u8] = 1;
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
    const n = this.ctx.dv().getUint32(at.u32, true);
    return this.ctx.u8().slice(at.focusOut, at.focusOut + n);
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
      const u8 = this.ctx.u8();
      u8.fill(0, base, base + P.size);
      u8.set(mime, base + mimeAt);
      u8.set(bytes, base + textAt);
      const dv = this.ctx.dv();
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
      const rc = ex.ghostty_terminal_paste(this.ctx.term, base, 0);
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
        const dv = this.ctx.dv();
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
  // Private: colours and the cursor blink
  // ==========================================================================

  private writeRgb(ptr: number, rgb: number): void {
    const u8 = this.ctx.u8();
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
    const dv = this.ctx.dv();
    dv.setUint16(at.mode + M.mode, MODE_CURSOR_BLINK, true);
    dv.setUint8(at.mode + M.value, this.blink ? 1 : 0);
    this.ctx.setOption(this.L.opt.MODE, at.mode, 'MODE 12');
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
      this.ctx.setOption(option, installed.index, what);
    };

    // WRITE_PTY(terminal, userdata, data, len): copy the reply out before returning.
    // Each call carries one whole reply. The kitty keyboard query reply is dropped:
    // webtty's input handler never encodes keys with the kitty flags, so answering
    // `CSI ? u` would tell apps the protocol is on when it is not (ADR 042).
    install(
      L.opt.WRITE_PTY,
      'WRITE_PTY',
      (_t, _u, ptr, len) => {
        const reply = this.ctx.u8().slice(ptr, ptr + len);
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
        const dv = this.ctx.dv();
        dv.setUint16(out + Z.rows, this.ctx.rows, true);
        dv.setUint16(out + Z.columns, this.ctx.cols, true);
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
        const dv = this.ctx.dv();
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
          if (this.ctx.dv().getUint32(notification + N.size, true) < N.bodyEnd) return undefined;
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
    const dv = this.ctx.dv();
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
    const out = this.ctx.dv();
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
    const dv = this.ctx.dv();
    const data = dv.getUint32(ptr + S.ptr, true);
    const len = dv.getUint32(ptr + S.len, true);
    return len === 0 ? new Uint8Array(0) : this.ctx.u8().slice(data, data + len);
  }

  private applyConfig(config: GhosttyTerminalConfig | undefined): void {
    const L = this.L;
    const at = this.at;

    // Scrollback in lines under a 32 MiB ceiling (ADR 046). Whichever limit is reached
    // first applies. 0 bytes would disable scrollback and a NULL byte limit would
    // remove the ceiling, so neither is ever passed; NULL lines removes the line limit.
    const lines = config?.scrollbackLines ?? DEFAULT_SCROLLBACK_LINES;
    this.ctx.dv().setUint32(at.u32, SCROLLBACK_CEILING_BYTES, true);
    this.ctx.setOption(L.opt.SCROLLBACK_MAX_BYTES, at.u32, 'SCROLLBACK_MAX_BYTES');
    if (lines > 0) this.ctx.dv().setUint32(at.u32, lines, true);
    this.ctx.setOption(L.opt.SCROLLBACK_MAX_LINES, lines > 0 ? at.u32 : 0, 'SCROLLBACK_MAX_LINES');

    // Grapheme clustering (mode 2027) on by default, so RIS keeps it.
    const dv = this.ctx.dv();
    dv.setUint16(at.mode + L.mode.mode, 2027, true);
    dv.setUint8(at.mode + L.mode.value, 1);
    this.ctx.setOption(L.opt.MODE_DEFAULT, at.mode, 'MODE_DEFAULT 2027');

    // The configured cursor, which DECSCUSR Ps 0 and RIS restore (ADR 049).
    this.setDefaultCursor(config?.cursorStyle ?? 'block', config?.cursorBlink ?? false);

    const setColor = (option: number, value: number, what: string) => {
      this.writeRgb(at.u32, value);
      this.ctx.setOption(option, at.u32, what);
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
        this.ctx.term,
        L.tdata.COLOR_PALETTE_DEFAULT,
        at.palette
      );
      if (rc !== 0) throw new Error(`libghostty-vt COLOR_PALETTE_DEFAULT failed: ${rc}`);
      for (const { value, i } of entries) this.writeRgb(at.palette + i * L.colors.rgbSize, value);
      this.ctx.setOption(L.opt.COLOR_PALETTE, at.palette, 'COLOR_PALETTE');
    }
  }

  // ==========================================================================
  // Private: single-cell lookups (grid_ref)
  // ==========================================================================

  /** Resolves a point to a grid reference at `out` (by default `at.gridRef`). */
  private gridRef(tag: number, x: number, y: number, out: number = this.at.gridRef): boolean {
    const L = this.L;
    const at = this.at;
    const P = L.point;
    this.ctx.u8().fill(0, at.point, at.point + P.size);
    const dv = this.ctx.dv();
    dv.setInt32(at.point + P.tag, tag, true);
    dv.setUint16(at.point + P.value + P.x, x, true);
    dv.setUint32(at.point + P.value + P.y, y, true);
    this.ctx.u8().fill(0, out, out + L.gridRef.size);
    dv.setUint32(out + L.gridRef.sizeField, L.gridRef.size, true);
    return this.ex.ghostty_terminal_grid_ref(this.ctx.term, at.point, out) === 0;
  }

  // ==========================================================================
  // Private: selection (ADR 050)
  // ==========================================================================

  private screenRef(cell: ScreenCell, out: number): boolean {
    if (cell.col < 0 || cell.col >= this.ctx.cols || cell.row < 0) return false;
    return this.gridRef(this.L.point.SCREEN, cell.col, cell.row, out);
  }

  /** The screen cell of the grid reference at `ref`, or null if it has none. */
  private screenCellOf(ref: number): ScreenCell | null {
    const at = this.at;
    const P = this.L.point;
    const rc = this.ex.ghostty_terminal_point_from_grid_ref(this.ctx.term, ref, P.SCREEN, at.coord);
    if (rc !== 0) return null;
    const dv = this.ctx.dv();
    return { col: dv.getUint16(at.coord + P.x, true), row: dv.getUint32(at.coord + P.y, true) };
  }

  /** Zeroes the GhosttySelection at `at.sel` and sets its size field. */
  private clearSelectionStruct(): void {
    const S = this.L.selection;
    this.ctx.u8().fill(0, this.at.sel, this.at.sel + S.size);
    this.ctx.dv().setUint32(this.at.sel + S.sizeField, S.size, true);
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
    this.ctx.info();
    this.ctx.u8().fill(0, at.selOpts, at.selOpts + options.size);
    this.ctx.dv().setUint32(at.selOpts + options.sizeField, options.size, true);
    if (!this.screenRef(cell, at.selOpts + options.ref)) return null;
    this.clearSelectionStruct();
    if (call(at.selOpts, at.sel) !== 0) return null;
    const start = this.screenCellOf(at.sel + S.start);
    const end = this.screenCellOf(at.sel + S.end);
    return start && end ? { start, end } : null;
  }

  private hyperlinkAt(tag: number, x: number, y: number): string | null {
    if (x < 0 || x >= this.ctx.cols || y < 0) return null;
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
        const n = this.ctx.dv().getUint32(at.u32, true);
        if (rc === this.L.result.OUT_OF_SPACE) {
          cap = n;
          continue;
        }
        if (rc !== 0 || n === 0) return null;
        return new TextDecoder().decode(this.ctx.u8().slice(buf, buf + n));
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
    if (this.ex.ghostty_terminal_get(this.ctx.term, this.L.tdata.TITLE, at.str) !== 0) return;
    const dv = this.ctx.dv();
    const ptr = dv.getUint32(at.str + S.ptr, true);
    const len = dv.getUint32(at.str + S.len, true);
    this.pendingTitle = len ? new TextDecoder().decode(this.ctx.u8().slice(ptr, ptr + len)) : '';
  }
}
