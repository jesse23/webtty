// The part of the terminal kitty graphics reads and writes (types + util, ADR 032): the
// cursor, the cell size, the scrollback and the smooth-scroll offset, and the
// CSS-to-device scale images are sized with.

import { axisScale } from '../protocol/cell-geometry';

/** What kitty graphics needs from the terminal; the vendored `Terminal` satisfies it. */
export interface KittyTerminal {
  write(data: string): void;
  readonly buffer: { readonly active: { readonly cursorX: number; readonly cursorY: number } };
  /** Rows scrolled back from the bottom. */
  readonly viewportY: number;
  readonly renderer?: {
    getMetrics(): { width: number; height: number } | undefined;
    readonly scrollOffset: number;
  };
  readonly wasmTerm?: { isAlternateScreen(): boolean; getScrollbackLength(): number };
  /** Whether painting waits for the app's synchronized update to end (mode 2026, ADR 067). */
  renderHeld?(now: number): boolean;
  /** Fires when a synchronized update was painted as it ended, between frames (ADR 067). */
  readonly onUpdatePainted?: (listener: () => void) => { dispose(): void };
}

/** A cell's size in CSS pixels, with ghostty-web's defaults before the renderer exists. */
export interface CellSize {
  width: number;
  height: number;
}

/**
 * Device pixels per CSS pixel, per axis. Sizes Ghostty reports to programs (CSI 14t/16t)
 * are device pixels, as in kitty: programs such as terminal-browser divide them by the
 * display's scale factor to get CSS pixels, so reporting CSS pixels makes their content
 * render at the wrong size. On a 2x display this means 4x the pixels per full-window
 * frame. Cell sizes are whole device pixels (see protocol/cell-geometry.ts), so the
 * CSS-to-device scale is per axis. See ADR 032.
 */
export interface Scale {
  x: number;
  y: number;
}

/** The terminal's cell size, 8x16 until the renderer has measured the font. */
export function cellSize(term: KittyTerminal): CellSize {
  const m = term.renderer?.getMetrics();
  return { width: m?.width ?? 8, height: m?.height ?? 16 };
}

/** The scale an image placed now is sized for, from the cell size and `devicePixelRatio`. */
export function deviceScale(cell: CellSize, devicePixelRatio: number): Scale {
  const dpr = devicePixelRatio || 1;
  return { x: axisScale(cell.width, dpr), y: axisScale(cell.height, dpr) };
}

/** Scrollback rows above the screen; the alternate screen has none, so its rows are viewport rows. */
export function scrollbackLength(term: KittyTerminal): number {
  const wasm = term.wasmTerm;
  if (!wasm || wasm.isAlternateScreen()) return 0;
  return wasm.getScrollbackLength();
}

/** The pixel offset of pixel-smooth scrolling (ADR 040, ADR 043). */
export function scrollOffset(term: KittyTerminal): number {
  return term.renderer?.scrollOffset ?? 0;
}
