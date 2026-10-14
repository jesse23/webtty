// webtty (ADR 061), not from upstream.
// What Terminal's collaborators see of it (types): narrow interfaces instead of the
// Terminal, CanvasRenderer and engine classes, so a split part never imports a facade and
// no import cycle forms (ADR 061).

import type { GhosttyTerminal } from '../engine/engine-types';

/**
 * What SelectionManager needs from the terminal: its size, the copyOnSelect option, the
 * viewport position, and scrolling for the drag auto-scroll.
 */
export interface SelectionHost {
  readonly cols: number;
  readonly rows: number;
  readonly options: { readonly copyOnSelect?: boolean };
  /** Lines scrolled into history; fractional while smooth scrolling. */
  getViewportY(): number;
  scrollLines(amount: number): void;
}

/**
 * What SelectionManager reads from the renderer: the canvas it listens on, the cell size,
 * and how far row 0 sits below the canvas top while smooth scrolling (ADR 043).
 */
export interface SelectionCanvasSource {
  getCanvas(): HTMLCanvasElement;
  getMetrics(): { width: number; height: number };
  readonly scrollOffset: number;
}

/**
 * The engine calls a selection makes: Ghostty's word, line and output ranges and the
 * selected text (ADR 050, ADR 057), mouse tracking (ADR 051), and the grid's size.
 */
export type SelectionEngineSource = Pick<
  GhosttyTerminal,
  | 'getScrollbackLength'
  | 'getDimensions'
  | 'hasMouseTracking'
  | 'selectWord'
  | 'selectLine'
  | 'selectOutput'
  | 'selectionText'
>;
