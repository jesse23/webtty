// Derived from coder/ghostty-web lib/renderer.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The cell size of a font (util): measured from 'M' on a 2D context, with padding for
// glyphs that overflow their box (ADR 061).

/** A character cell's size and baseline, in CSS pixels. */
export interface FontMetrics {
  width: number; // Character cell width in CSS pixels
  height: number; // Character cell height in CSS pixels
  baseline: number; // Distance from top to text baseline
}

/** What `measureText` reports that the cell size is built from. */
export type TextMeasure = Pick<
  TextMetrics,
  'width' | 'actualBoundingBoxAscent' | 'actualBoundingBoxDescent'
>;

/**
 * The cell for a font of `fontSize` pixels from the measure of 'M' (typically the widest
 * character). A context that reports no bounding box gets 80% ascent and 20% descent.
 */
export function fontMetricsFrom(measure: TextMeasure, fontSize: number): FontMetrics {
  const width = Math.ceil(measure.width);

  // Measure height using ascent + descent with padding for glyph overflow
  const ascent = measure.actualBoundingBoxAscent || fontSize * 0.8;
  const descent = measure.actualBoundingBoxDescent || fontSize * 0.2;

  // Add 2px padding to height to account for glyphs that overflow (like 'f', 'd', 'g', 'p')
  // and anti-aliasing pixels
  const height = Math.ceil(ascent + descent) + 2;
  const baseline = Math.ceil(ascent) + 1; // Offset baseline by half the padding

  return { width, height, baseline };
}

/** Measures the cell of `fontSize`px `fontFamily` on `ctx` (use an offscreen canvas's). */
export function measureFont(
  ctx: Pick<CanvasRenderingContext2D, 'font' | 'measureText'>,
  fontSize: number,
  fontFamily: string
): FontMetrics {
  // Set font (use actual pixel size for accurate measurement)
  ctx.font = `${fontSize}px ${fontFamily}`;
  return fontMetricsFrom(ctx.measureText('M'), fontSize);
}
