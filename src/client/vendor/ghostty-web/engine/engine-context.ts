// webtty (ADR 042, ADR 061), not from upstream.
// The state one terminal's bindings share (object): the wasm exports and layout, the
// terminal handle, the scratch slots, the grid size, the content generation, and the
// terminal info read once per generation. Memory views are built per call, never stored.

import type { EngineHost } from './engine-types';
import type { OfficialLayout } from './official-layout';
import { Scratch } from './scratch';
import type { OfficialWasmExports } from './wasm-exports';

/** A binding's scratch slots: name → [size, align]. */
export type SlotSpec<K extends string> = Record<K, readonly [number, number]>;

/**
 * The slots the context itself uses: the terminal info multi-get, the viewport scroll
 * struct, and the one-word out-parameters every binding shares.
 */
function contextSlots(L: OfficialLayout) {
  return {
    tKeys: [16, 4],
    tVals: [16, 4],
    curX: [4, 4],
    curY: [4, 4],
    sbRows: [4, 4],
    screen: [4, 4],
    scroll: [L.scroll.size, 8],
    u32: [8, 8],
    u8: [8, 8],
  } as const;
}

/** The names of the context's own scratch slots. */
export type ContextSlot = keyof ReturnType<typeof contextSlots>;

/**
 * One terminal's shared engine state (ADR 061). Bindings hold the context and read its
 * fields directly; `K` names the scratch slots the bindings declared on top of the
 * context's own, so each binding sees the slots it asked for.
 */
export class EngineContext<K extends string = never> {
  readonly vt: EngineHost;
  readonly ex: OfficialWasmExports;
  readonly L: OfficialLayout;
  readonly scratch: Scratch;
  /** Every slot's address, the context's and the bindings'. */
  readonly at: Readonly<Record<K | ContextSlot, number>>;
  /** The terminal handle; 0 once freed. */
  term: number;
  cols: number;
  rows: number;
  /**
   * Bumped by every content change (scrolling is not one): gates the render-state
   * refresh and the info read, and keys the scrollback page cache.
   */
  generation = 1;

  // Terminal info, read by `info()` once per generation.
  cursorX = 0;
  cursorY = 0;
  sbRows = 0;
  altScreen = false;
  private infoGen = 0;

  constructor(vt: EngineHost, cols: number, rows: number, slots: SlotSpec<K>) {
    this.vt = vt;
    this.ex = vt.ex;
    this.L = vt.L;
    this.cols = cols;
    this.rows = rows;
    const ex = this.ex;
    const L = this.L;
    this.term = vt.newHandle('terminal_new', (slot) => ex.ghostty_terminal_new(0, slot, cols, rows));
    const { scratch, at } = Scratch.create(ex, { ...contextSlots(L), ...slots });
    this.scratch = scratch;
    this.at = at as Record<K | ContextSlot, number>;
    this.setU32s(at.tKeys, [
      L.tdata.CURSOR_X,
      L.tdata.CURSOR_Y,
      L.tdata.SCROLLBACK_ROWS,
      L.tdata.ACTIVE_SCREEN,
    ]);
    this.setU32s(at.tVals, [at.curX, at.curY, at.sbRows, at.screen]);
  }

  /** A fresh byte view; never keep one across an export call. */
  u8(): Uint8Array {
    return new Uint8Array(this.ex.memory.buffer);
  }

  /** A fresh DataView; never keep one across an export call. */
  dv(): DataView {
    return new DataView(this.ex.memory.buffer);
  }

  /** Writes consecutive little-endian u32 values from `ptr`. */
  setU32s(ptr: number, values: number[]): void {
    const dv = this.dv();
    values.forEach((v, i) => dv.setUint32(ptr + i * 4, v, true));
  }

  /** Cursor, scrollback rows and active screen, read once per generation. */
  info(): void {
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

  /** `terminal_set`, throwing with `what` in the message when Ghostty refuses it. */
  setOption(option: number, value: number, what: string): void {
    const rc = this.ex.ghostty_terminal_set(this.term, option, value);
    if (rc !== 0) throw new Error(`libghostty-vt terminal_set ${what} failed: ${rc}`);
  }

  /**
   * Moves Ghostty's viewport (`GhosttyTerminalScrollViewport`). webtty's view is its own
   * offset, so only page reads and prompt jumps move it, and they move it back.
   */
  scrollViewport(tag: number, value: number): void {
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
}
