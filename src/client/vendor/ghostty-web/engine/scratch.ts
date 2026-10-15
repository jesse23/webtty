// webtty (ADR 042, ADR 061), not from upstream.
// The scratch allocator (object): one wasm allocation per terminal, carved into aligned,
// named slots for the out-parameters and small structs of export calls.

import type { OfficialWasmExports } from './wasm-exports';

/** The two exports a scratch block needs, so it can be tested on a fake allocator. */
export type ScratchAllocator = Pick<
  OfficialWasmExports,
  'ghostty_wasm_alloc' | 'ghostty_wasm_free'
>;

/** Scratch memory: one wasm allocation carved into aligned, named slots. */
export class Scratch {
  readonly base: number;
  readonly len: number;
  private readonly ex: ScratchAllocator;

  private constructor(ex: ScratchAllocator, base: number, len: number) {
    this.ex = ex;
    this.base = base;
    this.len = len;
  }

  /** Allocates the slots; each value is [size, align]. Returns the slot addresses. */
  static create<K extends string>(
    ex: ScratchAllocator,
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

  /** Frees the one allocation; the slot addresses are invalid after. */
  free(): void {
    this.ex.ghostty_wasm_free(this.base, this.len);
  }
}
