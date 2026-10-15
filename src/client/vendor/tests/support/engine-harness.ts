// Engine parts on a real wasm instance without the OfficialTerminal facade (test support,
// ADR 064): contexts with one binding's slots, raw writes that bump the generation as the
// facade's do, and a host that records the callbacks a binding installs and releases.

import { EngineContext, type SlotSpec } from '../../ghostty-web/engine/engine-context';
import type { EngineHost } from '../../ghostty-web/engine/engine-types';
import { type RenderStateSlot, renderStateSlots } from '../../ghostty-web/engine/render-state';
import type { InstalledFn } from '../../ghostty-web/fn-table';
import type { Ghostty } from '../../ghostty-web/ghostty';

/** A context for a `cols` × `rows` terminal with the render state's scratch slots. */
export function renderContext(
  vt: Ghostty,
  cols: number,
  rows: number,
): EngineContext<RenderStateSlot> {
  return new EngineContext(vt, cols, rows, renderStateSlots(vt.L));
}

/** A context for a `cols` × `rows` terminal with the scratch slots a binding declares. */
export function bindingContext<K extends string>(
  vt: EngineHost,
  cols: number,
  rows: number,
  slots: SlotSpec<K>,
): EngineContext<K> {
  return new EngineContext(vt, cols, rows, slots);
}

/** One callback a binding installed, and how many times it was released. */
export interface TrackedInstall {
  index: number;
  releases: number;
}

/**
 * `vt` with a function table that records every install, so a test can check that a
 * binding's `free()` releases each callback it installed, once.
 */
export function trackedHost(vt: Ghostty): { host: EngineHost; installs: TrackedInstall[] } {
  const installs: TrackedInstall[] = [];
  const fnTable = {
    install(...args: Parameters<Ghostty['fnTable']['install']>): InstalledFn {
      const real = vt.fnTable.install(...args);
      const record = { index: real.index, releases: 0 };
      installs.push(record);
      return {
        index: real.index,
        release: () => {
          record.releases++;
          real.release();
        },
      };
    },
  };
  const host: EngineHost = Object.create(vt, { fnTable: { value: fnTable } });
  return { host, installs };
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
