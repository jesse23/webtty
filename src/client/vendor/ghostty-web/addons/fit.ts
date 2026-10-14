/**
 * FitAddon - Proposes the grid that fits the terminal's container
 *
 * Usage:
 * ```typescript
 * const fitAddon = new FitAddon();
 * term.loadAddon(fitAddon);
 * const dims = fitAddon.proposeDimensions();
 * if (dims) term.resize(dims.cols, dims.rows);
 * ```
 *
 * (webtty: upstream's fit() and observeResize() are removed; webtty resizes the
 * terminal itself from proposeDimensions, ADR 033.)
 */

import type { ITerminalAddon, ITerminalCore } from '../interfaces';

// ============================================================================
// Constants
// ============================================================================

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

// ============================================================================
// Types
// ============================================================================

export interface ITerminalDimensions {
  cols: number;
  rows: number;
}

export interface IFitPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Cols and rows that fit in a `width` x `height` element (clientWidth/Height, which
 * include padding) after its padding, with the given cell size. No space is
 * reserved for a scrollbar: the scrollbar is an overlay drawn inside the canvas.
 */
export function fitDimensions(
  width: number,
  height: number,
  padding: IFitPadding,
  cellWidth: number,
  cellHeight: number
): ITerminalDimensions {
  const availableWidth = width - padding.left - padding.right;
  const availableHeight = height - padding.top - padding.bottom;
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor(availableWidth / cellWidth)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(availableHeight / cellHeight)),
  };
}

// ============================================================================
// FitAddon Class
// ============================================================================

export class FitAddon implements ITerminalAddon {
  private _terminal?: ITerminalCore;

  /**
   * Activate the addon (called by Terminal.loadAddon)
   */
  public activate(terminal: ITerminalCore): void {
    this._terminal = terminal;
  }

  /**
   * Dispose the addon and clean up resources
   */
  public dispose(): void {
    this._terminal = undefined;
  }

  /**
   * Propose dimensions to fit the terminal to its container
   *
   * Calculates cols and rows based on:
   * - Terminal container element dimensions (clientWidth/Height)
   * - Terminal element padding
   * - Font metrics (character cell size)
   *
   * @returns Proposed dimensions or undefined if cannot calculate
   */
  public proposeDimensions(): ITerminalDimensions | undefined {
    // Need terminal and its DOM element
    if (!this._terminal?.element) {
      return undefined;
    }

    // Access terminal internals to get renderer
    const terminal = this._terminal as any;
    const renderer = terminal.renderer;

    if (!renderer || typeof renderer.getMetrics !== 'function') {
      return undefined;
    }

    // Get font metrics from renderer
    const metrics = renderer.getMetrics();
    if (!metrics || metrics.width === 0 || metrics.height === 0) {
      return undefined;
    }

    // Get terminal element (container) dimensions
    // Use clientWidth/clientHeight to get the INSIDE dimensions (excluding padding)
    const terminalElement = this._terminal.element;

    // Check if we have clientWidth/clientHeight (DOM element required)
    if (typeof terminalElement.clientWidth === 'undefined') {
      return undefined;
    }

    const elementStyle = window.getComputedStyle(terminalElement);

    // Get the actual content area (inside padding)
    const paddingTop = Number.parseInt(elementStyle.getPropertyValue('padding-top')) || 0;
    const paddingBottom = Number.parseInt(elementStyle.getPropertyValue('padding-bottom')) || 0;
    const paddingLeft = Number.parseInt(elementStyle.getPropertyValue('padding-left')) || 0;
    const paddingRight = Number.parseInt(elementStyle.getPropertyValue('padding-right')) || 0;

    // Use clientWidth/clientHeight which gives us the inside dimensions
    // This is stable and doesn't grow with content
    const containerWidth = terminalElement.clientWidth;
    const containerHeight = terminalElement.clientHeight;

    // Check for invalid dimensions
    if (containerWidth === 0 || containerHeight === 0) {
      return undefined;
    }

    // Subtract padding (clientWidth includes it) and enforce minimums
    return fitDimensions(
      containerWidth,
      containerHeight,
      { top: paddingTop, right: paddingRight, bottom: paddingBottom, left: paddingLeft },
      metrics.width,
      metrics.height
    );
  }
}
