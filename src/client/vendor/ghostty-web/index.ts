// Derived from coder/ghostty-web lib/index.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The vendored layer's public barrel: the only path webtty's app code imports vendor code
// through (ADR 060, ADR 061). It follows xterm.js' naming.

// Main Terminal class
export { Terminal } from './terminal';

// xterm.js-compatible interfaces
export type {
  ITerminalOptions,
  ITheme,
  ITerminalAddon,
  ITerminalCore,
  IDisposable,
  IEvent,
} from './interfaces';

// Ghostty WASM components (for advanced usage)
export {
  Ghostty,
  OfficialTerminal,
  CellFlags,
  DirtyState,
  KeyEncoderOption,
} from './ghostty';
export type {
  DesktopNotification,
  GhosttyTerminal,
  KeyEncoder,
  TerminalEffects,
} from './ghostty';
export { Key, KeyAction, Mods } from './types';
export type { KeyEvent, GhosttyCell } from './types';

// Low-level components (for custom integrations)
export { CanvasRenderer } from './renderer';
export type { RendererOptions, FontMetrics, IRenderable } from './renderer';
export { InputHandler } from './input-handler';
export { EventEmitter } from './event-emitter';
export { SelectionManager } from './selection-manager';
export type { SelectionCoordinates } from './selection-manager';

// Addons
export { FitAddon } from './addons/fit';
export type { ITerminalDimensions } from './addons/fit';

// Link providers
export { OSC8LinkProvider } from './providers/osc8-link-provider';
export { UrlRegexProvider } from './providers/url-regex-provider';
export { LinkDetector } from './link-detector';
export type { ILink, ILinkProvider, IBufferCellPosition } from './types';

// webtty's scrolling motion (ADR 045), DPR tracking (ADR 039) and teardown (ADR 065)
export { AT_ONCE, easeOutCubic, FRAME_MS, Glide, linear } from './glide';
export type { Ease, Pace } from './glide';
export { watchDevicePixelRatio } from './renderer';
export { DisposableStore, listen, toDisposable } from './lifecycle/disposable-store';
export type { Disposable, ListenerTarget } from './lifecycle/disposable-store';
