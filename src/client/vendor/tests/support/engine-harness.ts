// Engine parts on a real wasm instance without the OfficialTerminal facade (test support,
// ADR 064): a context with the render state's slots, and raw writes that bump its
// generation as the facade's do.

import { EngineContext } from '../../ghostty-web/engine/engine-context';
import { type RenderStateSlot, renderStateSlots } from '../../ghostty-web/engine/render-state';
import type { Ghostty } from '../../ghostty-web/ghostty';

/** A context for a `cols` × `rows` terminal with the render state's scratch slots. */
export function renderContext(
  vt: Ghostty,
  cols: number,
  rows: number,
): EngineContext<RenderStateSlot> {
  return new EngineContext(vt, cols, rows, renderStateSlots(vt.L));
}

/** Feeds `text` to the terminal through `vt_write` and bumps the generation. */
export function writeVt(ctx: EngineContext, text: string): void {
  const bytes = new TextEncoder().encode(text);
  const ptr = ctx.ex.ghostty_wasm_alloc(bytes.length);
  ctx.u8().set(bytes, ptr);
  ctx.ex.ghostty_terminal_vt_write(ctx.term, ptr, bytes.length);
  ctx.ex.ghostty_wasm_free(ptr, bytes.length);
  ctx.generation++;
}

/** Frees the terminal and the scratch, as the facade's `free()` ends. */
export function freeContext(ctx: EngineContext): void {
  ctx.ex.ghostty_terminal_free(ctx.term);
  ctx.term = 0;
  ctx.scratch.free();
}
