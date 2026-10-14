// Derived from coder/ghostty-web lib/types.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// A re-export shim (types) for the files that still import './types': the definitions live
// in input/key-types.ts, engine/cell-types.ts, engine/engine-types.ts and link-types.ts.
// V15 moves the importers to those paths and removes this file (ADR 061).

export { Key, KeyAction, KeyEncoderOption, Mods } from './input/key-types';
export type { KeyEvent } from './input/key-types';
export { CellFlags, DirtyState } from './engine/cell-types';
export type { GhosttyCell, RenderStateCursor } from './engine/cell-types';
export type { GhosttyTerminalConfig } from './engine/engine-types';
export type { IBufferCellPosition, IBufferRange, ILink, ILinkProvider } from './link-types';
