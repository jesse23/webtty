import { describe, expect, test } from 'bun:test';
import { DEFAULT_THEME } from '../../ghostty-web/render/default-theme';
import type { PaintSettings } from '../../ghostty-web/render/renderable';
import { ROW_INVALID, ROW_JOINED } from '../../ghostty-web/render/row-band';
import { ScrollbarPainter } from '../../ghostty-web/render/scrollbar-painter';

/** A context that records calls and writes as strings. */
function recordingContext() {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_t, key) =>
        (...args: unknown[]) =>
          calls.push(`${String(key)}(${args.join(',')})`),
      set: (_t, key, value) => {
        calls.push(`${String(key)}=${value}`);
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const settings: PaintSettings = {
  fontSize: 15,
  fontFamily: 'mono',
  metrics: { width: 8, height: 20, baseline: 14 },
  theme: DEFAULT_THEME,
  devicePixelRatio: 2,
};

/** A painter over a 200 CSS px wide canvas at ratio 2. */
function painter() {
  const counter = { draws: 0 };
  const canvas = { width: 400 } as HTMLCanvasElement;
  return { p: new ScrollbarPainter(canvas, settings, counter), counter };
}

describe('ScrollbarPainter.paint', () => {
  test('clears its column over the rows in view, then draws the track and thumb', () => {
    const { p, counter } = painter();
    const { ctx, calls } = recordingContext();
    // 5 rows in view from canvas row 2, 15 lines of scrollback, scrolled up 3, at half opacity
    p.paint(ctx, 3, 15, 5, 0.5, 2);
    expect(calls).toEqual([
      'clearRect(186,40,14,100)',
      `fillStyle=${DEFAULT_THEME.background}`,
      'fillRect(186,40,14,100)',
      'fillStyle=rgba(128, 128, 128, 0.05)',
      'fillRect(188,44,8,92)',
      'fillStyle=rgba(128, 128, 128, 0.25)',
      'fillRect(188,99.2,8,23)',
    ]);
    expect(counter.draws).toBe(1);
  });

  test.each([
    ['fully transparent', 3, 15, 0],
    ['without scrollback', 0, 0, 1],
  ])('%s, it only clears its column', (_name, viewportY, scrollback, opacity) => {
    const { p } = painter();
    const { ctx, calls } = recordingContext();
    p.paint(ctx, viewportY, scrollback, 5, opacity, 0);
    expect(calls.length).toBe(3);
  });

  test('at the bottom the thumb is fainter', () => {
    const { p } = painter();
    const { ctx, calls } = recordingContext();
    p.paint(ctx, 0, 15, 5, 1, 0);
    expect(calls).toContain('fillStyle=rgba(128, 128, 128, 0.3)');
  });
});

describe('ScrollbarPainter.moveTo', () => {
  const state = () => new Uint8Array(10).fill(ROW_JOINED);
  const invalid = (s: Uint8Array) => [...s.keys()].filter((k) => s[k] === ROW_INVALID);

  test('invalidates the rows the old scrollbar covered that the new one does not', () => {
    const { p } = painter();
    let s = state();
    p.moveTo(s, 2, 4);
    expect(invalid(s)).toEqual([]);
    // Same rows: nothing
    s = state();
    p.moveTo(s, 2, 4);
    expect(invalid(s)).toEqual([]);
    // Two rows down: the two it left
    s = state();
    p.moveTo(s, 4, 4);
    expect(invalid(s)).toEqual([4, 5].map((k) => k - 2));
    // Dropped: every row it covered
    s = state();
    p.moveTo(s, null, 4);
    expect(invalid(s)).toEqual([4, 5, 6, 7]);
    s = state();
    p.moveTo(s, null, 4);
    expect(invalid(s)).toEqual([]);
  });

  test('follows a copied scroll', () => {
    const { p } = painter();
    p.moveTo(state(), 2, 4);
    p.shift(3);
    const s = state();
    p.moveTo(s, 5, 4);
    expect(invalid(s)).toEqual([]);
    p.moveTo(state(), null, 4);
    p.shift(3);
    const after = state();
    p.moveTo(after, 1, 4);
    expect(invalid(after)).toEqual([]);
  });
});
