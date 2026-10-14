// webtty (ADR 049, ADR 053, ADR 061), not from upstream.
// The paste and focus binding (object): pastes text through `ghostty_terminal_paste`,
// which brackets and sanitises it for the app's modes, with a mime reader callback
// installed on the first paste, and encodes focus reports.

import { type InstalledFn, WasmValType } from '../fn-table';
import type { EngineContext } from './engine-context';

/** Room for one focus report (`CSI I` / `CSI O`, 3 bytes). */
export const FOCUS_REPORT_MAX = 8;

/** The scratch slots the paste and focus binding declares on the shared context. */
export function pasteFocusSlots() {
  return {
    focusOut: [FOCUS_REPORT_MAX, 8],
  } as const;
}

/** The names of the paste and focus binding's scratch slots. */
export type PasteFocusSlot = keyof ReturnType<typeof pasteFocusSlots>;

const I32 = WasmValType.I32;

/** Paste (ADR 049) and focus reports (ADR 053) on one terminal. */
export class PasteFocusBinding {
  private readonly ctx: EngineContext<PasteFocusSlot>;
  // The mime reader callback, installed on the first paste, and the text it writes
  // during a `paste` call.
  private reader: InstalledFn | null = null;
  private text = { ptr: 0, len: 0 };

  constructor(ctx: EngineContext<PasteFocusSlot>) {
    this.ctx = ctx;
  }

  /** Pastes `text` as from the clipboard; the reply, if any, is a WRITE_PTY effect. */
  paste(text: string): void {
    const ex = this.ctx.ex;
    const P = this.ctx.L.paste;
    const S = this.ctx.L.string;
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
      dv.setUint32(base + P.reader + P.readerRead, this.ensureReader(), true);
      // Text that could run commands (a newline without 2004) is sent, never refused:
      // ADR 037, and webtty has no confirmation dialog.
      dv.setUint8(base + P.allowUnsafe, 1);
      this.text = { ptr: base + textAt, len: bytes.length };
      const rc = ex.ghostty_terminal_paste(this.ctx.term, base, 0);
      if (rc !== 0) throw new Error(`libghostty-vt terminal_paste failed: ${rc}`);
    } finally {
      this.text = { ptr: 0, len: 0 };
      ex.ghostty_wasm_free(base, len);
    }
  }

  /** The focus gained or lost report (`CSI I` / `CSI O`). */
  encodeFocus(focused: boolean): Uint8Array {
    const { at, L } = this.ctx;
    const F = L.focus;
    const event = focused ? F.GAINED : F.LOST;
    const rc = this.ctx.ex.ghostty_focus_encode(event, at.focusOut, FOCUS_REPORT_MAX, at.u32);
    if (rc !== 0) return new Uint8Array(0);
    const n = this.ctx.dv().getUint32(at.u32, true);
    return this.ctx.u8().slice(at.focusOut, at.focusOut + n);
  }

  /**
   * Releases the reader's table slot; call only after the terminal is freed, when
   * nothing can call it (fn-table.ts rule 3). Safe to call again.
   */
  free(): void {
    this.reader?.release();
    this.reader = null;
  }

  /**
   * The GhosttyMimeReader callback: `(userdata, mime, writer)`, the GhosttyString and
   * GhosttyWriter structs passed by pointer on wasm32. It writes the text of the paste in
   * progress through the writer, a function in the wasm's table, and returns its result.
   */
  private ensureReader(): number {
    if (this.reader) return this.reader.index;
    const P = this.ctx.L.paste;
    const table = this.ctx.ex.__indirect_function_table;
    this.reader = this.ctx.vt.fnTable.install(
      ((_userdata: number, _mime: number, writer: number) => {
        const { ptr, len } = this.text;
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
    return this.reader.index;
  }
}
