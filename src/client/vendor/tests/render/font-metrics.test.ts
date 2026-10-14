import { describe, expect, test } from 'bun:test';
import { fontMetricsFrom, measureFont } from '../../ghostty-web/render/font-metrics';

// The cell size from a measure of 'M': rounded up, with 2px of overflow padding.

describe('fontMetricsFrom', () => {
  test.each([
    [
      'whole bounds',
      { width: 9, ascent: 11, descent: 3 },
      15,
      { width: 9, height: 16, baseline: 12 },
    ],
    [
      'fractional bounds',
      { width: 8.4, ascent: 10.2, descent: 2.5 },
      14,
      { width: 9, height: 15, baseline: 12 },
    ],
    [
      'no bounding box: 80% / 20% of the size',
      { width: 9, ascent: 0, descent: 0 },
      15,
      { width: 9, height: 17, baseline: 13 },
    ],
    [
      'no descent',
      { width: 7, ascent: 10, descent: 0 },
      10,
      { width: 7, height: 14, baseline: 11 },
    ],
  ])('%s', (_name, m, fontSize, metrics) => {
    const measure = {
      width: m.width,
      actualBoundingBoxAscent: m.ascent,
      actualBoundingBoxDescent: m.descent,
    };
    expect(fontMetricsFrom(measure, fontSize)).toEqual(metrics);
  });
});

describe('measureFont', () => {
  test("sets the font and measures 'M'", () => {
    const measured: string[] = [];
    const ctx = {
      font: '',
      measureText(text: string) {
        measured.push(`${ctx.font}|${text}`);
        return {
          width: 9,
          actualBoundingBoxAscent: 11,
          actualBoundingBoxDescent: 3,
        } as TextMetrics;
      },
    };
    expect(measureFont(ctx, 15, 'monospace')).toEqual({ width: 9, height: 16, baseline: 12 });
    expect(measured).toEqual(['15px monospace|M']);
  });
});
