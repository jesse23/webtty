// Derived from coder/ghostty-web lib/ghostty.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The engine's facade (factory): `Ghostty` loads Ghostty's official libghostty-vt wasm and
// creates terminals and key encoders on it, and this file re-exports the engine types the
// rest of the layer imports from here (ADR 041, ADR 042, ADR 047, ADR 061). Every wasm
// call is in engine/.

import { CellFlags, DirtyState, type GhosttyCell, type RenderStateCursor } from './engine/cell-types';
import type { EngineHost, GhosttyTerminalConfig, KeyEncoder } from './engine/engine-types';
import { OfficialKeyEncoder } from './engine/key-encoder-binding';
import {
  OFFICIAL_ENCODER_OPTION_NAMES,
  OFFICIAL_KEY_NAMES,
  translateEnum,
} from './engine/key-tables';
import { type OfficialLayout, resolveOfficialLayout } from './engine/official-layout';
import { OfficialTerminal } from './engine/official-terminal';
import { readVtLayout } from './engine/vt-layout';
import type { OfficialWasmExports } from './engine/wasm-exports';
import { loadWasmExports } from './engine/wasm-loader';
import { FnTable } from './fn-table';
import { Key, KeyAction, KeyEncoderOption } from './input/key-types';

// Re-export types for convenience
export {
  CellFlags,
  DirtyState,
  type GhosttyCell,
  type GhosttyTerminalConfig,
  KeyEncoderOption,
  OfficialTerminal,
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

/**
 * A loaded libghostty-vt wasm instance (ADR 041, ADR 042): creates terminals and
 * key encoders.
 */
export class Ghostty implements EngineHost {
  /** @internal The wasm exports; only engine/ calls them. */
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
