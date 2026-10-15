// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The cell painter (object): draws a canvas row's backgrounds, then its text and
// decorations, on the context it is given, with the colour precedence in two pure
// functions. The per-cell hot path: no allocation per cell beyond the colour string (ADR 061).

import { CellFlags, type GhosttyCell } from '../engine/cell-types';
import type { ITheme } from '../interfaces';
import { highlightAt } from '../search';
import { cellInRange } from './cell-range';
import type {
  CellTextPainter,
  DrawCounter,
  FrameDecorations,
  GraphemeLookup,
  PaintSettings,
  RowContent,
  RowPainter,
} from './renderable';

/** A colour from its red, green and blue bytes, as the canvas takes it. */
export function rgbToCSS(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The colour a cell's background is filled with, or null to leave the row's theme
 * background: the selection over a search match (the selected match in its own colour)
 * over the cell's own background, which INVERSE swaps with its foreground. Black is the
 * engine's default background and is not filled.
 */
export function cellBackground(
  cell: GhosttyCell,
  selected: boolean,
  match: 0 | 1 | 2,
  theme: Required<ITheme>
): string | null {
  // Selection background replaces cell background
  if (selected) return theme.selectionBackground;
  // A search match replaces it too, under the selection as in Ghostty (webtty, ADR 055)
  if (match) return match === 2 ? theme.searchSelectedBackground : theme.searchBackground;
  // When inverted, background becomes foreground
  const inverse = cell.flags & CellFlags.INVERSE;
  const r = inverse ? cell.fg_r : cell.bg_r;
  const g = inverse ? cell.fg_g : cell.bg_g;
  const b = inverse ? cell.fg_b : cell.bg_b;
  // Only draw cell background if it's different from the default (black)
  // This lets the theme background (drawn earlier) show through for default cells
  if (r === 0 && g === 0 && b === 0) return null;
  return rgbToCSS(r, g, b);
}

/**
 * The colour a cell's text is drawn in: the selection's foreground over a search match's
 * (the selected match's in its own colour) over the cell's own, which INVERSE swaps with
 * its background. A caller's override (the block cursor's accent) comes before all of them.
 */
export function cellForeground(
  cell: GhosttyCell,
  selected: boolean,
  match: 0 | 1 | 2,
  theme: Required<ITheme>
): string {
  if (selected) return theme.selectionForeground;
  if (match) return match === 2 ? theme.searchSelectedForeground : theme.searchForeground;
  // When inverted, foreground becomes background
  const inverse = cell.flags & CellFlags.INVERSE;
  return inverse
    ? rgbToCSS(cell.bg_r, cell.bg_g, cell.bg_b)
    : rgbToCSS(cell.fg_r, cell.fg_g, cell.fg_b);
}

/** The colour of the hovered link's underline. */
export const LINK_UNDERLINE_COLOR = '#4A90E2';

/**
 * Paints rows of cells with the shared settings and the frame's decorations. Every method
 * takes the context to draw on, so a partial repaint passes the scratch canvas' context
 * instead of swapping the renderer's. (webtty, ADR 043, ADR 061)
 */
export class CellPainter implements RowPainter, CellTextPainter {
  constructor(
    private readonly settings: PaintSettings,
    private readonly frame: FrameDecorations,
    private readonly counter: DrawCounter
  ) {}

  /** Draws canvas row `k`; a row with no line (past the buffer's ends) is left blank. */
  paintRow(
    ctx: CanvasRenderingContext2D,
    k: number,
    cols: number,
    { line, grapheme }: RowContent
  ): void {
    this.counter.draws++;
    if (line) {
      this.paintLine(ctx, line, k, cols, grapheme ?? blankGrapheme);
      return;
    }
    const { metrics, theme } = this.settings;
    const y = k * metrics.height;
    const width = cols * metrics.width;
    ctx.clearRect(0, y, width, metrics.height);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, y, width, metrics.height);
  }

  /**
   * Render a single line using two-pass approach:
   * 1. First pass: Draw all cell backgrounds
   * 2. Second pass: Draw all cell text and decorations
   *
   * This two-pass approach is necessary for proper rendering of complex scripts
   * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
   * base character into the previous cell's visual area. If we draw backgrounds
   * and text in a single pass (cell by cell), the background of cell N would
   * cover any left-extending portions of graphemes from cell N-1.
   */
  paintLine(
    ctx: CanvasRenderingContext2D,
    line: GhosttyCell[],
    y: number,
    cols: number,
    grapheme: GraphemeLookup
  ): void {
    this.counter.draws++;
    const { metrics, theme } = this.settings;
    const lineY = y * metrics.height;
    const lineWidth = cols * metrics.width;

    // Clear line background then fill with theme color.
    // We clear just the cell area - glyph overflow is handled by also
    // redrawing the row below (see RowRepainter).
    // clearRect is needed because fillRect composites rather than replaces,
    // so transparent/translucent backgrounds wouldn't clear previous content.
    ctx.clearRect(0, lineY, lineWidth, metrics.height);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, lineY, lineWidth, metrics.height);

    // PASS 1: Draw all cell backgrounds first
    // This ensures all backgrounds are painted before any text, allowing text
    // to "bleed" across cell boundaries without being covered by adjacent backgrounds
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.paintCellBackground(ctx, cell, x, y);
    }

    // PASS 2: Draw all cell text and decorations
    // Now text can safely extend beyond cell boundaries (for complex scripts)
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell.width === 0) continue; // Skip spacer cells for wide characters
      this.paintCellText(ctx, cell, x, y, undefined, grapheme);
    }
  }

  /**
   * Render a cell's background only (Pass 1 of two-pass rendering)
   * Selection highlighting is integrated here to avoid z-order issues with
   * complex glyphs (like Devanagari) that extend outside their cell bounds.
   */
  paintCellBackground(ctx: CanvasRenderingContext2D, cell: GhosttyCell, x: number, y: number): void {
    const { metrics, theme } = this.settings;
    const selected = cellInRange(this.frame.selection, x, y);
    const fill = cellBackground(cell, selected, highlightAt(this.frame.searchSpans[y], x), theme);
    if (fill === null) return;
    ctx.fillStyle = fill;
    ctx.fillRect(x * metrics.width, y * metrics.height, metrics.width * cell.width, metrics.height);
  }

  /**
   * Render a cell's text and decorations (Pass 2 of two-pass rendering)
   * Selection foreground color is applied here to match the selection background.
   */
  paintCellText(
    ctx: CanvasRenderingContext2D,
    cell: GhosttyCell,
    x: number,
    y: number,
    colorOverride: string | undefined,
    grapheme: GraphemeLookup
  ): void {
    // Skip rendering if invisible
    if (cell.flags & CellFlags.INVISIBLE) return;
    const { metrics, theme } = this.settings;
    const cellX = x * metrics.width;
    const cellY = y * metrics.height;
    const cellWidth = metrics.width * cell.width;

    // Set text style
    let fontStyle = '';
    if (cell.flags & CellFlags.ITALIC) fontStyle += 'italic ';
    if (cell.flags & CellFlags.BOLD) fontStyle += 'bold ';
    ctx.font = `${fontStyle}${this.settings.fontSize}px ${this.settings.fontFamily}`;

    // Set text color - use override, selection foreground, search or normal color
    ctx.fillStyle =
      colorOverride ||
      cellForeground(
        cell,
        cellInRange(this.frame.selection, x, y),
        highlightAt(this.frame.searchSpans[y], x),
        theme
      );

    // Apply faint effect
    const faint = cell.flags & CellFlags.FAINT;
    if (faint) ctx.globalAlpha = 0.5;

    // A cell with extra codepoints draws its whole grapheme cluster, a simple cell its
    // one codepoint (a space if null)
    const char = cell.grapheme_len > 0 ? grapheme(x) : String.fromCodePoint(cell.codepoint || 32);
    ctx.fillText(char, cellX, cellY + metrics.baseline);

    // Reset alpha
    if (faint) ctx.globalAlpha = 1.0;

    if (cell.flags & CellFlags.UNDERLINE) {
      drawLine(ctx, ctx.fillStyle, cellX, cellX + cellWidth, cellY + metrics.baseline + 2);
    }
    if (cell.flags & CellFlags.STRIKETHROUGH) {
      drawLine(ctx, ctx.fillStyle, cellX, cellX + cellWidth, cellY + metrics.height / 2);
    }
    // Draw the hovered link's underline (OSC 8 or plain text URL), in canvas rows
    // (webtty, ADR 043)
    if (cellInRange(this.frame.link, x, y)) {
      drawLine(ctx, LINK_UNDERLINE_COLOR, cellX, cellX + cellWidth, cellY + metrics.baseline + 2);
    }
  }
}

/** The lookup for a row that came without one: every cluster a space. */
const blankGrapheme: GraphemeLookup = () => ' ';

/** A 1 px horizontal line in `style` from `x0` to `x1` at `y`. */
function drawLine(
  ctx: CanvasRenderingContext2D,
  style: CanvasRenderingContext2D['strokeStyle'],
  x0: number,
  x1: number,
  y: number
): void {
  ctx.strokeStyle = style;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}
