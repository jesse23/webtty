// webtty (ADR 042, ADR 043, ADR 061), not from upstream.
// The render-state binding (object, the per-cell decode hot path): keeps a JS copy of the
// active screen up to date through Ghostty's render state, once per generation, and
// decodes rows of any render state into JS-owned cells. Kept as one unit (ADR 061).

import { CellFlags, DirtyState, type GhosttyCell, type RenderStateCursor } from './cell-types';
import type { EngineContext } from './engine-context';
import type { OfficialLayout } from './official-layout';
import { blankCell, blankCells, type RowRef, setRgb } from './row-ref';
import { readBits } from './vt-layout';

interface DecodedStyle {
  /** 0xRRGGBB, or -1 for the default. */
  fg: number;
  bg: number;
  flags: number;
}

/** Grapheme codepoints read through the scratch buffer; longer clusters allocate. */
const GRAPHEME_SCRATCH = 32;

/** The scratch slots the render state declares on the shared context. */
export function renderStateSlots(L: OfficialLayout) {
  return {
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
    gBuf: [GRAPHEME_SCRATCH * 4, 8],
  } as const;
}

/** The names of the render state's scratch slots. */
export type RenderStateSlot = keyof ReturnType<typeof renderStateSlots>;

/**
 * The active screen through Ghostty's render state (ADR 042, ADR 043).
 *
 * A refresh runs `render_state_update`, visits the dirty rows with
 * `row_iterator_next_dirty`, and decodes each row's `CELLS_RAW` into JS-owned cells
 * indexed by active row. Refreshes happen only when the generation (bumped by writes,
 * resizes and pixel-size changes) has changed, so the many `update()` calls of one
 * frame decode each row once. Ghostty's viewport stays at the bottom, so this copy is
 * the active screen; `decodePage` reads the rows of another render state, for the
 * scrollback pages.
 */
export class RenderState {
  private readonly ctx: EngineContext<RenderStateSlot>;
  private rs: number;
  private iter: number;
  private rowCells: number;

  // Refresh state. The JS dirty state accumulates until `markClean()`.
  private refreshedGen = 0;
  private decodeAll = true;
  private readonly dirtyRows = new Set<number>();
  private dirtyMax: DirtyState = DirtyState.NONE;

  // The JS copy of the active screen, indexed by active row.
  private viewCells: GhosttyCell[] = [];
  private viewGraphemes: (Map<number, string> | null)[] = [];
  private raw = new Uint32Array(0);
  private readonly rowStyles = new Map<number, DecodedStyle>();

  // Render-state cursor and colours from the last refresh.
  private cursorVisible = true;
  private cursorBlinking = false;
  private cursorStyle: RenderStateCursor['style'] = 'block';
  private defFg = 0xffffff;
  private defBg = 0;
  private readonly palette = new Uint8Array(256 * 3);

  constructor(ctx: EngineContext<RenderStateSlot>) {
    this.ctx = ctx;
    const { vt, ex, L, at } = ctx;
    this.rs = vt.newHandle('render_state_new', (slot) => ex.ghostty_render_state_new(0, slot));
    this.iter = vt.newHandle('row_iterator_new', (slot) =>
      ex.ghostty_render_state_row_iterator_new(0, slot)
    );
    this.rowCells = vt.newHandle('row_cells_new', (slot) =>
      ex.ghostty_render_state_row_cells_new(0, slot)
    );
    // Fixed scratch contents: handle slots and the key/value arrays of the multi-gets.
    const dv = ctx.dv();
    dv.setUint32(at.iterH, this.iter, true);
    dv.setUint32(at.cellsH, this.rowCells, true);
    ctx.setU32s(at.rsKeys, [L.rs.DIRTY, L.rs.CURSOR, L.rs.COLORS]);
    ctx.setU32s(at.rsVals, [at.dirty, at.cursor, at.colors]);
    ctx.setU32s(at.rowKeys, [L.row.CELLS_RAW, L.row.VIEWPORT_Y, L.row.CELLS]);
    ctx.setU32s(at.rowVals, [at.view, at.viewY, at.cellsH]);
    this.allocView();
  }

  /** Refreshes and returns the dirt accumulated since `markClean()`. */
  update(): DirtyState {
    this.refresh();
    return this.dirtyMax;
  }

  /** The cursor as of the latest content. */
  getCursor(): RenderStateCursor {
    this.refresh();
    const ctx = this.ctx;
    return {
      x: ctx.cursorX,
      y: ctx.cursorY,
      viewportX: ctx.cursorX,
      viewportY: ctx.cursorY,
      visible: this.cursorVisible,
      blinking: this.cursorBlinking,
      style: this.cursorStyle,
    };
  }

  /** Whether active row `y` changed since `markClean()`. */
  isRowDirty(y: number): boolean {
    this.refresh();
    return this.dirtyMax === DirtyState.FULL || this.dirtyRows.has(y);
  }

  /** Forgets the accumulated dirt, once the renderer has drawn it. */
  markClean(): void {
    this.dirtyRows.clear();
    this.dirtyMax = DirtyState.NONE;
  }

  /** Makes the next frame repaint every row (the view came back to the bottom). */
  markAllDirty(): void {
    this.dirtyMax = DirtyState.FULL;
  }

  /** The active screen's cells, row-major; the array is the live copy, not a snapshot. */
  getViewport(): GhosttyCell[] {
    this.refresh();
    return this.viewCells;
  }

  /** Active row `y` of the copy; call `refresh()` first. */
  viewRow(y: number): RowRef {
    const cols = this.ctx.cols;
    return { cells: this.viewCells, base: y * cols, graphemes: this.viewGraphemes[y] };
  }

  /** After a resize: size the copy to the new grid and decode every row on the next refresh. */
  resized(): void {
    this.decodeAll = true;
    this.allocView();
  }

  /**
   * Brings the active-screen copy up to date with the terminal, once per generation. Each
   * refresh decodes only the rows Ghostty reports dirty (every row after a resize or
   * colour change), adds them to the dirty set, and ends with `render_state_clean`,
   * which clears Ghostty's global and per-row dirty state. The JS dirty state
   * accumulates until `markClean()`.
   */
  refresh(): void {
    const ctx = this.ctx;
    if (this.refreshedGen === ctx.generation) return;
    ctx.info();
    const { ex, L, at } = ctx;

    let rc = ex.ghostty_render_state_update(this.rs, ctx.term);
    if (rc !== 0) throw new Error(`libghostty-vt render_state_update failed: ${rc}`);
    let dv = ctx.dv();
    dv.setUint32(at.cursor + L.cursor.sizeField, L.cursor.size, true);
    dv.setUint32(at.colors + L.colors.sizeField, L.colors.size, true);
    rc = ex.ghostty_render_state_get_multi(this.rs, 3, at.rsKeys, at.rsVals, 0);
    if (rc !== 0) throw new Error(`libghostty-vt render_state_get_multi failed: ${rc}`);
    // Decoded cells carry the default fg/bg and palette colours, but Ghostty marks no
    // row dirty when only the defaults change (OSC 10/11/110/111, DECSCNM): its own
    // renderer applies them globally. Redecode every row when any colour changed.
    const colorsChanged = this.readCursorAndColors();
    dv = ctx.dv();
    const dirty = dv.getInt32(at.dirty, true);
    rc = ex.ghostty_render_state_get(this.rs, L.rs.ROW_ITERATOR, at.iterH);
    if (rc !== 0) throw new Error(`libghostty-vt ROW_ITERATOR failed: ${rc}`);

    const all = this.decodeAll || colorsChanged;
    const cols = ctx.cols;
    const rows = ctx.rows;
    while (
      all
        ? ex.ghostty_render_state_row_iterator_next(this.iter)
        : ex.ghostty_render_state_row_iterator_next_dirty(this.iter, at.y)
    ) {
      const len = this.readRowRaw();
      const y = ctx.dv().getInt32(at.viewY, true);
      if (y < 0 || y >= rows) continue;
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
    this.refreshedGen = ctx.generation;
  }

  /**
   * Decodes every row of render state `pageRs`, already updated for the rows wanted, into
   * fresh rows indexed by viewport row; rows it does not report are blank. Uses the
   * shared row iterator and the colours of the last `refresh()`, so call that first.
   */
  decodePage(pageRs: number): RowRef[] {
    const ctx = this.ctx;
    const { ex, L, at } = ctx;
    const rows = ctx.rows;
    const cols = ctx.cols;
    if (ex.ghostty_render_state_get(pageRs, L.rs.ROW_ITERATOR, at.iterH) !== 0) {
      throw new Error('libghostty-vt ROW_ITERATOR failed');
    }
    const page: RowRef[] = [];
    while (ex.ghostty_render_state_row_iterator_next(this.iter)) {
      const len = this.readRowRaw();
      const y = ctx.dv().getInt32(at.viewY, true);
      if (y < 0 || y >= rows) continue;
      const cells = blankCells(cols);
      page[y] = { cells, base: 0, graphemes: this.decodeRow(cells, 0, len) };
    }
    for (let y = 0; y < rows; y++) {
      if (!page[y]) page[y] = { cells: blankCells(cols), base: 0, graphemes: null };
    }
    return page;
  }

  /** Frees the render state, its row iterator and row-cells handles. */
  free(): void {
    const ex = this.ctx.ex;
    ex.ghostty_render_state_row_cells_free(this.rowCells);
    ex.ghostty_render_state_row_iterator_free(this.iter);
    ex.ghostty_render_state_free(this.rs);
    this.rowCells = 0;
    this.iter = 0;
    this.rs = 0;
  }

  private allocView(): void {
    const total = this.ctx.cols * this.ctx.rows;
    while (this.viewCells.length < total) this.viewCells.push(blankCell());
    this.viewCells.length = total;
    this.viewGraphemes = new Array(this.ctx.rows).fill(null);
  }

  private rgbAt(ptr: number): number {
    const u8 = this.ctx.u8();
    const C = this.ctx.L.colors;
    return (u8[ptr + C.r] << 16) | (u8[ptr + C.g] << 8) | u8[ptr + C.b];
  }

  /** Returns whether the default colours or the palette changed since the last read. */
  private readCursorAndColors(): boolean {
    const { L, at } = this.ctx;
    const u8 = this.ctx.u8();
    const dv = this.ctx.dv();
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
    const { ex, L, at } = this.ctx;
    const rc = ex.ghostty_render_state_row_get_multi(this.iter, 3, at.rowKeys, at.rowVals, 0);
    if (rc !== 0) throw new Error(`libghostty-vt render_state_row_get_multi failed: ${rc}`);
    const dv = this.ctx.dv();
    const ptr = dv.getUint32(at.view + L.cellsView.ptr, true);
    const len = dv.getUint32(at.view + L.cellsView.len, true);
    const words = (len * L.cellSize) / 4;
    if (this.raw.length < words) this.raw = new Uint32Array(words);
    if (ptr && words) this.raw.set(new Uint32Array(ex.memory.buffer, ptr, words));
    return len;
  }

  /**
   * Decodes the copied raw row into `out[base..base+cols)`. Styles come from a
   * per-row cache (`row_cells_get` STYLE only for an id not seen in the row), and
   * grapheme codepoints are read only for cells tagged as graphemes.
   *
   * Over the 60-line function budget on purpose: this loop runs once per cell of every
   * decoded row, so its layout reads are hoisted into locals and the cell is written
   * in place, with no per-cell call, closure or allocation (ADR 061).
   */
  private decodeRow(out: GhosttyCell[], base: number, len: number): Map<number, string> | null {
    const L = this.ctx.L;
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
    const cols = this.ctx.cols;
    const styles = this.rowStyles;
    styles.clear();
    let graphemes: Map<number, string> | null = null;
    const n = Math.min(len, cols);
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
    for (let x = n; x < cols; x++) {
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

  /** The style of cell `x` of the bound row, its colours resolved through the palette. */
  private readStyle(x: number): DecodedStyle {
    const { ex, L } = this.ctx;
    const S = L.style;
    const C = L.styleColor;
    const p = this.ctx.at.style;
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

  /** The codepoints of grapheme cell `x` of the bound row; clusters over 32 allocate. */
  private readGrapheme(x: number): number[] {
    const { ex, L, at } = this.ctx;
    ex.ghostty_render_state_row_cells_select(this.rowCells, x);
    if (ex.ghostty_render_state_row_cells_get(this.rowCells, L.cellData.GRAPHEMES_LEN, at.u32)) {
      return [];
    }
    const n = this.ctx.dv().getUint32(at.u32, true);
    if (n === 0) return [];
    const big = n > GRAPHEME_SCRATCH;
    const buf = big ? ex.ghostty_wasm_alloc(n * 4) : at.gBuf;
    try {
      if (ex.ghostty_render_state_row_cells_get(this.rowCells, L.cellData.GRAPHEMES_BUF, buf)) {
        return [];
      }
      const dv = this.ctx.dv();
      const cps: number[] = [];
      for (let i = 0; i < n; i++) cps.push(dv.getUint32(buf + i * 4, true));
      return cps;
    } finally {
      if (big) ex.ghostty_wasm_free(buf, n * 4);
    }
  }
}
