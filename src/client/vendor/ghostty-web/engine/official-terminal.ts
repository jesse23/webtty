// webtty (ADR 042, ADR 047, ADR 061, ADR 066), not from upstream.
// The terminal on the official libghostty-vt wasm (facade): `OfficialTerminal` implements
// the `GhosttyTerminal` interface the rest of the vendored layer uses, on the wasm instance
// (`EngineHost`) that `Ghostty.createTerminal` passes it. It owns the writes, the size,
// the view offset and Ghostty's own viewport (moved for a prompt jump or pinned across a
// write, then put back at the bottom), and delegates every other area to a binding on one
// `EngineContext`.

import { DirtyState, type GhosttyCell, type RenderStateCursor } from './cell-types';
import { type ConfigSlot, configSlots, EngineConfig } from './engine-config';
import { EngineContext } from './engine-context';
import { type EffectsSlot, EngineEffects, effectsSlots } from './engine-effects';
import type {
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
import { type GridRefSlot, GridRefs, gridRefSlots } from './grid-refs';
import {
  type MouseEncoderSlot,
  MouseEncoderBinding,
  mouseEncoderSlots,
} from './mouse-encoder-binding';
import type { OfficialLayout } from './official-layout';
import { type PasteFocusSlot, PasteFocusBinding, pasteFocusSlots } from './paste-focus-binding';
import { RenderState, type RenderStateSlot, renderStateSlots } from './render-state';
import { copyRow, graphemeOf } from './row-ref';
import { ScrollbackPages } from './scrollback-pages';
import { type SearchSlot, SearchBinding, searchSlots } from './search-binding';
import { type SelectionSlot, SelectionBinding, selectionSlots } from './selection-binding';

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

/** Bytes as one char each, for scanning ASCII sequences in byte output. */
const LATIN1 = new TextDecoder('latin1');

/** The facade's own scratch slot: the scrollbar a prompt jump reads. */
function facadeSlots(L: OfficialLayout) {
  return { scrollbar: [L.scrollbar.size, 8] } as const;
}

type FacadeSlot = keyof ReturnType<typeof facadeSlots>;
type TerminalSlot =
  | FacadeSlot
  | RenderStateSlot
  | GridRefSlot
  | SelectionSlot
  | SearchSlot
  | MouseEncoderSlot
  | PasteFocusSlot
  | EffectsSlot
  | ConfigSlot;

/**
 * The scratch slot specs of the facade and each binding, in one list so a test can
 * check that no two declare the same name (a later spread would silently share it).
 */
export function terminalSlotSpecs(L: OfficialLayout) {
  return [
    renderStateSlots(L),
    gridRefSlots(L),
    selectionSlots(L),
    searchSlots(L),
    mouseEncoderSlots(L),
    pasteFocusSlots(),
    effectsSlots(L),
    configSlots(L),
    facadeSlots(L),
  ] as const;
}

/** Every slot the terminal's context allocates, beyond the context's own. */
function terminalSlots(L: OfficialLayout): Record<TerminalSlot, readonly [number, number]> {
  return Object.assign({}, ...terminalSlotSpecs(L));
}

/**
 * A terminal on the official libghostty-vt wasm (ADR 042).
 *
 * Rows are read through `RenderState`, which keeps a JS copy of the active screen up to
 * date once per generation, and `ScrollbackPages`, which reads scrollback a page at a
 * time and caches it until the content changes, so scrolling only records the offset
 * and serves rows from the copy and the cache. Selection, search, mouse, paste and
 * focus reports, the callbacks and the config each have a binding (ADR 061).
 */
export class OfficialTerminal implements GhosttyTerminal {
  private readonly ctx: EngineContext<TerminalSlot>;
  private readonly render: RenderState;
  private readonly pages: ScrollbackPages;
  private readonly refs: GridRefs;
  private readonly selection: SelectionBinding;
  private readonly search: SearchBinding;
  private readonly mouse: MouseEncoderBinding;
  private readonly pasteFocus: PasteFocusBinding;
  private readonly effects: EngineEffects;
  private readonly config: EngineConfig;

  // The view's offset: lines scrolled up from the bottom. Ghostty's viewport stays at
  // the bottom; only page reads move it, and they move it back.
  private offset = 0;

  constructor(vt: EngineHost, cols: number, rows: number, config?: GhosttyTerminalConfig) {
    const ctx = new EngineContext(vt, cols, rows, terminalSlots(vt.L));
    this.ctx = ctx;
    this.render = new RenderState(ctx);
    this.pages = new ScrollbackPages(ctx, this.render);
    this.refs = new GridRefs(ctx);
    this.selection = new SelectionBinding(ctx, this.refs);
    this.search = new SearchBinding(ctx, this.refs);
    this.mouse = new MouseEncoderBinding(ctx);
    this.pasteFocus = new PasteFocusBinding(ctx);
    // The callbacks are installed before the config is applied, as Ghostty sees them.
    this.effects = new EngineEffects(ctx, {
      clipboardWrite: config?.clipboardWrite ?? true,
      desktopNotifications: config?.desktopNotifications ?? true,
    });
    this.config = new EngineConfig(ctx);
    this.config.apply(config);
  }

  get cols(): number {
    return this.ctx.cols;
  }

  get rows(): number {
    return this.ctx.rows;
  }

  // Lifecycle

  write(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.feed(bytes, typeof data === 'string' ? data : undefined, false);
  }

  writeUntilGround(data: Uint8Array): number | null {
    return this.feed(data, undefined, true);
  }

  /** vt_write, or vt_write_until_ground: the bytes consumed, null if ground was not reached. */
  private feed(bytes: Uint8Array, text: string | undefined, untilGround: boolean): number | null {
    // The view's offset is kept: a write leaves Ghostty's viewport at the bottom (a pin is
    // released after it, ADR 066), and the renderer repaints what the write changed.
    const { ex, at, L } = this.ctx;
    let consumed: number | null = bytes.length;
    // until_ground takes NULL for no bytes, and then only says whether it is at ground
    const ptr = bytes.length > 0 ? ex.ghostty_wasm_alloc(bytes.length) : 0;
    if (bytes.length > 0 && !ptr) throw new Error('libghostty-vt: out of memory');
    if (ptr) this.ctx.u8().set(bytes, ptr);
    if (untilGround) {
      const rc = ex.ghostty_terminal_vt_write_until_ground(this.ctx.term, ptr, bytes.length, at.u32);
      consumed = rc === L.result.SUCCESS ? this.ctx.dv().getUint32(at.u32, true) : null;
    } else if (ptr) {
      ex.ghostty_terminal_vt_write(this.ctx.term, ptr, bytes.length);
    }
    if (ptr) ex.ghostty_wasm_free(ptr, bytes.length);
    const fed = consumed ?? bytes.length;
    if (fed > 0) this.config.afterWrite(text ?? LATIN1.decode(bytes.subarray(0, fed)));
    this.ctx.generation++;
    this.effects.afterWrite();
    return consumed;
  }

  resize(cols: number, rows: number, cellWidthPx?: number, cellHeightPx?: number): void {
    const ctx = this.ctx;
    if (cols === ctx.cols && rows === ctx.rows) {
      if (cellWidthPx !== undefined && cellHeightPx !== undefined) {
        this.setCellPixelSize(cellWidthPx, cellHeightPx);
      }
      return;
    }
    ctx.cols = cols;
    ctx.rows = rows;
    if (cellWidthPx !== undefined && cellHeightPx !== undefined) {
      ctx.cellWidthPx = Math.max(0, Math.round(cellWidthPx));
      ctx.cellHeightPx = Math.max(0, Math.round(cellHeightPx));
    }
    // One call per real change: with mode 2048 on, every call sends a size report.
    const rc = ctx.ex.ghostty_terminal_resize(ctx.term, cols, rows, ctx.cellWidthPx, ctx.cellHeightPx);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_resize failed: ${rc}`);
    ctx.generation++;
    this.render.resized();
    // Reflow keeps Ghostty's viewport at the bottom; only the offset is clamped.
    if (this.offset > 0) this.setViewportOffset(this.offset);
  }

  setCellPixelSize(cellWidthPx: number, cellHeightPx: number): void {
    const ctx = this.ctx;
    const w = Math.max(0, Math.round(cellWidthPx));
    const h = Math.max(0, Math.round(cellHeightPx));
    if (w === ctx.cellWidthPx && h === ctx.cellHeightPx) return;
    ctx.cellWidthPx = w;
    ctx.cellHeightPx = h;
    const rc = ctx.ex.ghostty_terminal_resize(ctx.term, ctx.cols, ctx.rows, w, h);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_resize failed: ${rc}`);
    ctx.generation++;
  }

  setDefaultCursor(style: RenderStateCursor['style'], blink: boolean): void {
    this.config.setDefaultCursor(style, blink);
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
    if (!this.ctx.term) return;
    this.search.free();
    this.ctx.ex.ghostty_terminal_free(this.ctx.term);
    this.ctx.term = 0;
    // Callback slots are released only after nothing can call them (fn-table.ts rule 3).
    this.effects.free();
    this.pasteFocus.free();
    this.mouse.free();
    this.pages.free();
    this.render.free();
    this.ctx.scratch.free();
  }

  // Render state

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

  // Modes

  isAlternateScreen(): boolean {
    this.ctx.info();
    return this.ctx.altScreen;
  }

  hasMouseTracking(): boolean {
    return this.getFlag(this.ctx.L.tdata.MOUSE_TRACKING);
  }

  cursorAtPrompt(): boolean {
    return this.getFlag(this.ctx.L.tdata.CURSOR_AT_PROMPT);
  }

  promptJumpRow(top: number, delta: number): number {
    const S = this.ctx.L.scroll;
    this.ctx.info();
    // Ghostty moves its viewport from its top row, so it is put on webtty's for the move
    this.ctx.scrollViewport(S.ROW, top);
    try {
      this.ctx.scrollViewport(S.DELTA_PROMPT, delta);
      return this.viewportRow() ?? top;
    } finally {
      this.ctx.scrollViewport(S.BOTTOM, 0);
    }
  }

  pinViewport(row: number): void {
    this.ctx.info();
    this.ctx.scrollViewport(this.ctx.L.scroll.ROW, row);
  }

  unpinViewport(): number {
    // An erased scrollback leaves Ghostty's viewport on the screen, row 0 if it is all gone
    const row = this.viewportRow() ?? 0;
    this.ctx.scrollViewport(this.ctx.L.scroll.BOTTOM, 0);
    return row;
  }

  /** The screen row at the top of Ghostty's viewport, or null if Ghostty refuses the read. */
  private viewportRow(): number | null {
    const { ex, at, L } = this.ctx;
    const rc = ex.ghostty_terminal_get(this.ctx.term, L.tdata.SCROLLBAR, at.scrollbar);
    if (rc !== 0) return null;
    // The offset is a u64; a screen row fits in the low 32 bits
    return this.ctx.dv().getUint32(at.scrollbar + L.scrollbar.offset, true);
  }

  getMode(mode: number, isAnsi: boolean = false): boolean {
    return this.ctx.getMode(mode, isAnsi);
  }

  setMode(mode: number, on: boolean): void {
    this.ctx.setMode(mode, on);
  }

  /** A one-byte bool terminal data item; false if Ghostty refuses the read. */
  private getFlag(data: number): boolean {
    const at = this.ctx.at;
    const rc = this.ctx.ex.ghostty_terminal_get(this.ctx.term, data, at.u8);
    return rc === 0 && this.ctx.u8()[at.u8] !== 0;
  }

  // Scrollback, graphemes, hyperlinks

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
    return this.refs.isRowWrapped(row);
  }

  getHyperlinkUri(row: number, col: number): string | null {
    if (row < 0 || row >= this.ctx.rows) return null;
    return this.refs.hyperlinkAt(this.ctx.L.point.ACTIVE, col, row);
  }

  getScrollbackHyperlinkUri(offset: number, col: number): string | null {
    return this.refs.hyperlinkAt(this.ctx.L.point.HISTORY, col, offset);
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

  // Selection (ADR 050)

  selectWord(cell: ScreenCell): ScreenRange | null {
    return this.selection.selectWord(cell);
  }

  selectLine(cell: ScreenCell): ScreenRange | null {
    return this.selection.selectLine(cell);
  }

  selectOutput(cell: ScreenCell): ScreenRange | null {
    return this.selection.selectOutput(cell);
  }

  selectionText(start: ScreenCell, end: ScreenCell): string {
    return this.selection.selectionText(start, end);
  }

  // Search (ADR 055)

  setSearch(needle: string): void {
    this.search.setSearch(needle);
  }

  searchStep(budgetMs: number): boolean {
    return this.search.searchStep(budgetMs);
  }

  searchSelect(direction: 'next' | 'previous'): boolean {
    return this.search.searchSelect(direction);
  }

  searchState(): SearchState {
    return this.search.searchState();
  }

  searchSelectedMatch(): ScreenRange | null {
    return this.search.searchSelectedMatch();
  }

  searchMatches(): Int32Array {
    return this.search.searchMatches();
  }

  // Mouse, focus and paste (ADR 049, ADR 053)

  setMouseGeometry(geometry: MouseGeometry): void {
    this.mouse.setMouseGeometry(geometry);
  }

  encodeMouse(input: MouseInput): Uint8Array {
    return this.mouse.encodeMouse(input);
  }

  encodeFocus(focused: boolean): Uint8Array {
    return this.pasteFocus.encodeFocus(focused);
  }

  paste(text: string): void {
    this.pasteFocus.paste(text);
  }

  // Replies and effects

  hasResponse(): boolean {
    return this.effects.hasResponse();
  }

  readResponse(): string | null {
    return this.effects.readResponse();
  }

  readEffects(): TerminalEffects {
    return this.effects.readEffects();
  }
}
