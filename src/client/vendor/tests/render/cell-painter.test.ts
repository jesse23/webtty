import { describe, expect, test } from 'bun:test';
import { CellFlags, type GhosttyCell } from '../../ghostty-web/engine/cell-types';
import {
  CellPainter,
  cellBackground,
  cellForeground,
  LINK_UNDERLINE_COLOR,
  rgbToCSS,
} from '../../ghostty-web/render/cell-painter';
import { DEFAULT_THEME } from '../../ghostty-web/render/default-theme';
import type { FrameDecorations, PaintSettings } from '../../ghostty-web/render/renderable';
import { CanvasRenderer } from '../../ghostty-web/renderer';
import { recordingCanvas } from '../support/raster-canvas';
import { recordingContext } from '../support/recording-context';
import {
  COLS,
  ROWS,
  rasterRenderer,
  selectionOf,
  writtenTerminal,
} from '../support/renderer-harness';
import { loadGhostty } from '../support/wasm';

const theme = DEFAULT_THEME;

/** A cell with a red foreground and a blue background, plus `flags`. */
function cell(flags = 0, overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: 0x41,
    fg_r: 200,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 90,
    flags,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    ...overrides,
  };
}

describe('cell colours', () => {
  test('rgbToCSS writes the canvas colour', () => {
    expect(rgbToCSS(1, 2, 3)).toBe('rgb(1, 2, 3)');
  });

  // The selection over a search match (the selected one in its own colour) over the cell
  test.each([
    ['selected', true, 0, cell(), theme.selectionBackground],
    ['selected over a match', true, 2, cell(), theme.selectionBackground],
    ['a match', false, 1, cell(), theme.searchBackground],
    ['the selected match', false, 2, cell(), theme.searchSelectedBackground],
    ['its own', false, 0, cell(), 'rgb(0, 0, 90)'],
    ['inverse: its foreground', false, 0, cell(CellFlags.INVERSE), 'rgb(200, 0, 0)'],
    ['default black: none', false, 0, cell(0, { bg_b: 0 }), null],
    ['inverse of a black foreground: none', false, 0, cell(CellFlags.INVERSE, { fg_r: 0 }), null],
  ] as const)('background: %s', (_name, selected, match, c, expected) => {
    expect(cellBackground(c, selected, match, theme)).toBe(expected);
  });

  test.each([
    ['selected', true, 0, cell(), theme.selectionForeground],
    ['selected over a match', true, 1, cell(), theme.selectionForeground],
    ['a match', false, 1, cell(), theme.searchForeground],
    ['the selected match', false, 2, cell(), theme.searchSelectedForeground],
    ['its own', false, 0, cell(), 'rgb(200, 0, 0)'],
    ['inverse: its background', false, 0, cell(CellFlags.INVERSE), 'rgb(0, 0, 90)'],
  ] as const)('foreground: %s', (_name, selected, match, c, expected) => {
    expect(cellForeground(c, selected, match, theme)).toBe(expected);
  });
});

describe('CellPainter', () => {
  const settings: PaintSettings = {
    fontSize: 15,
    fontFamily: 'mono',
    metrics: { width: 8, height: 15, baseline: 11 },
    theme,
    devicePixelRatio: 1,
  };

  function painter(frame: Partial<FrameDecorations> = {}) {
    const counter = { draws: 0 };
    const decorations = { selection: null, searchSpans: [], link: null, ...frame };
    const { ctx, calls } = recordingContext();
    return { p: new CellPainter(settings, decorations, counter), ctx, calls, counter };
  }

  test('a row without a line is cleared to the background', () => {
    const t = painter();
    t.p.paintRow(t.ctx, 2, 3, { line: null });
    expect(t.calls).toEqual([
      'clearRect(0,30,24,15)',
      `fillStyle=${theme.background}`,
      'fillRect(0,30,24,15)',
    ]);
    expect(t.counter.draws).toBe(1);
  });

  test('a line draws every background before any text, skipping spacer cells', () => {
    const t = painter();
    const wide = cell(0, { codepoint: 0x4e2d, width: 2 });
    const spacer = cell(0, { codepoint: 0, width: 0 });
    t.p.paintRow(t.ctx, 0, 3, { line: [wide, spacer, cell()], grapheme: () => '?' });
    const kinds = t.calls.filter((c) => /^(fillRect|fillText)/.test(c));
    expect(kinds).toEqual([
      'fillRect(0,0,24,15)',
      'fillRect(0,0,16,15)',
      'fillRect(16,0,8,15)',
      'fillText(中,0,11)',
      'fillText(A,16,11)',
    ]);
    // The row and the line: two draws
    expect(t.counter.draws).toBe(2);
  });

  test('a row with no grapheme lookup draws its clusters as spaces', () => {
    const t = painter();
    t.p.paintRow(t.ctx, 0, 1, { line: [cell(0, { grapheme_len: 1 })] });
    expect(t.calls).toContain('fillText( ,0,11)');
  });

  test('text styles: bold italic font, faint alpha, underline, strike, invisible', () => {
    const t = painter();
    const flags = CellFlags.BOLD | CellFlags.ITALIC | CellFlags.FAINT;
    t.p.paintCellText(t.ctx, cell(flags), 0, 0, undefined, () => '');
    expect(t.calls).toEqual([
      'font=italic bold 15px mono',
      'fillStyle=rgb(200, 0, 0)',
      'globalAlpha=0.5',
      'fillText(A,0,11)',
      'globalAlpha=1',
    ]);
    t.calls.length = 0;
    t.p.paintCellText(
      t.ctx,
      cell(CellFlags.UNDERLINE | CellFlags.STRIKETHROUGH),
      1,
      0,
      '#abc',
      () => '',
    );
    expect(t.calls.filter((c) => c.startsWith('strokeStyle') || c.startsWith('moveTo'))).toEqual([
      'strokeStyle=#abc',
      'moveTo(8,13)',
      'strokeStyle=#abc',
      'moveTo(8,7.5)',
    ]);
    t.calls.length = 0;
    t.p.paintCellText(t.ctx, cell(CellFlags.INVISIBLE), 0, 0, undefined, () => '');
    expect(t.calls).toEqual([]);
  });

  test('the hovered link is underlined in the link colour', () => {
    const link = { startCol: 0, startRow: 0, endCol: 1, endRow: 0 };
    const t = painter({ link });
    t.p.paintCellText(t.ctx, cell(), 1, 0, undefined, () => '');
    t.p.paintCellText(t.ctx, cell(), 2, 0, undefined, () => '');
    expect(t.calls.filter((c) => c.startsWith('strokeStyle'))).toEqual([
      `strokeStyle=${LINK_UNDERLINE_COLOR}`,
    ]);
  });
});

describe('cells drawn through the renderer', () => {
  test(`draws scrollback graphemes from their own row`, async () => {
    const { canvas, drawn } = recordingCanvas();
    const document = { createElement: () => canvas } as unknown as Document;
    const ghostty = await loadGhostty();
    const term = ghostty.createTerminal(30, 6, { scrollbackLines: 10000 });
    // A grapheme at a different column on every line, so a lookup on the wrong
    // row finds something else.
    for (let i = 0; i < 20; i++) term.write(`${'x'.repeat(i % 7)}é ${i}\r\n`);
    term.write('$ abcdefghijklmnop');
    const sb = term.getScrollbackLength();
    const provider = {
      getScrollbackLine: (o: number) => term.getScrollbackLine(o),
      getScrollbackLength: () => sb,
      getScrollbackGraphemeString: (o: number, c: number) => term.getScrollbackGraphemeString(o, c),
    };
    const renderer = new CanvasRenderer(canvas, { devicePixelRatio: 1, overscan: 1 }, { document });
    renderer.resize(30, 6);
    renderer.render(term, true, 3, provider);
    // Below the overscan row, canvas rows 1-3 show the last three scrollback lines
    // (line i is the i-th written); rows 4-6 the top of the screen.
    for (let row = 0; row < 3; row++) {
      expect(drawn.get(row + 1)).toContain('é');
      expect(drawn.get(row + 1)?.join('')).toContain(` ${sb - 3 + row} `);
    }
    expect(drawn.get(4)).toContain('é');
    term.free();
  });

  test(`a hovered OSC 8 link underlines and repaints only its own range`, async () => {
    const ghostty = await loadGhostty();
    const term = ghostty.createTerminal(COLS, ROWS);
    // Two links, on rows 1 and 4: the engine gives every link cell the same hyperlink_id
    term.write('a\r\n\x1b]8;;https://a/\x1b\\first\x1b]8;;\x1b\\\r\nb\r\nc\r\n');
    term.write('\x1b]8;;https://b/\x1b\\second\x1b]8;;\x1b\\');
    expect(term.getLine(1)?.[0].hyperlink_id).toBe(term.getLine(4)?.[0].hyperlink_id);
    const live = rasterRenderer(1, { overscan: 2 });
    live.r.render(term, true, 0, undefined, 0);
    live.drawn.length = 0;
    live.r.setHoveredLinkRange({ startX: 0, startY: 4, endX: 5, endY: 4 });
    live.r.render(term, false, 0, undefined, 0);
    // The hovered row, the row above it, which may hold its overflow, and the row below,
    // which overflows into it (overscan rows first)
    expect([...new Set(live.drawn)].sort()).toEqual([3, 4, 5].map((y) => y + 2));
    const width = COLS * 8;
    const underlined = (y: number) =>
      live
        .shown()
        .slice(y * 15 * width, (y + 1) * 15 * width)
        .some((p) => p.startsWith(`line ${LINK_UNDERLINE_COLOR}`));
    expect([0, 1, 2, 3, 4, 5].map(underlined)).toEqual([false, false, false, false, true, false]);
    term.free();
  });

  test(`selection, link underline and cursor follow a scroll`, async () => {
    const { term, provider } = await writtenTerminal();
    const sb = provider.getScrollbackLength();
    let view = 0;
    // A selection anchored to buffer lines, as SelectionManager keeps it, reaching past
    // the viewport.
    const first = { startCol: 3, startLine: sb - 4, endCol: 12, endLine: sb + 2 };
    const second = { startCol: 0, startLine: sb - 12, endCol: 4, endLine: sb - 9 };
    let selection = first;
    const manager = selectionOf(
      term,
      () => selection,
      () => view,
    );
    const range = { startX: 2, startY: 6, endX: 9, endY: 6 };
    for (const overscan of [1, 4]) {
      const options = { overscan, theme: { cursor: 'rgba(255, 0, 0, 0.3)' } };
      const live = rasterRenderer(2, options);
      live.r.setSelectionManager(manager);
      live.r.setHoveredLinkRange(range);
      live.r.render(term, true, 0, provider, 1);
      selection = first;
      for (const [y, offset, changed] of [
        [1, 0],
        [3, 0],
        [3, 7.5],
        [2, 0.5],
        [0, 4],
        [0, 0],
        [2, 3],
        [7, 0],
        [9, 1],
        [6, 0],
        [6, 0, second],
        [6, 2],
        [11, 0],
        // The selection changes on a frame that copies rows, with the old one still in view
        [13, 0, first],
        [12, 0, second],
        [5, 3, first],
        [0, 0],
      ] as const) {
        if (changed) selection = changed;
        view = y;
        live.r.setScrollOffset(offset);
        live.r.render(term, false, view, provider, 1);
        const full = rasterRenderer(2, options);
        full.r.setSelectionManager(manager);
        full.r.setHoveredLinkRange(range);
        full.r.setScrollOffset(offset);
        full.r.render(term, true, view, provider, 1);
        expect(live.shown()).toEqual(full.shown());
      }
    }
    term.free();
  });

  test(`search highlights follow scrolls, output and selection changes (ADR 055)`, async () => {
    const { term, provider } = await writtenTerminal();
    const live = {
      provider: { ...provider, getScrollbackLength: () => term.getScrollbackLength() },
    };
    term.setSearch('g');
    while (term.searchStep(50)) {}
    const read = () => ({ matches: term.searchMatches(), selected: term.searchSelectedMatch() });
    let highlights = read();
    expect(highlights.matches.length).toBeGreaterThan(40);
    for (const overscan of [1, 4]) {
      const r = rasterRenderer(2, { overscan });
      r.r.setSearchHighlights(highlights);
      r.r.render(term, true, 0, live.provider, 0);
      const steps: [number, number, (() => void)?][] = [
        [0, 0],
        [3, 0, () => term.searchSelect('next')],
        [3, 7.5],
        [9, 0, () => term.searchSelect('next')],
        [12, 0],
        [6, 2, () => term.searchSelect('previous')],
        [0, 0, () => term.write('one more g\r\n')],
        [2, 0],
        [2, 0, () => term.setSearch('plain')],
        [0, 0, () => term.setSearch('')],
      ];
      for (const [view, offset, change] of steps) {
        if (change) {
          change();
          while (term.searchStep(50)) {}
          highlights = read();
          r.r.setSearchHighlights(highlights.matches.length ? highlights : null);
        }
        r.r.setScrollOffset(offset);
        r.r.render(term, false, view, live.provider, 0);
        const full = rasterRenderer(2, { overscan });
        full.r.setSearchHighlights(highlights.matches.length ? highlights : null);
        full.r.setScrollOffset(offset);
        full.r.render(term, true, view, live.provider, 0);
        expect(r.shown()).toEqual(full.shown());
      }
      term.setSearch('g');
      while (term.searchStep(50)) {}
      highlights = read();
    }
    // The matches' text in the search colours, the selected one's in its own
    const r = rasterRenderer(1, {
      theme: { searchForeground: '#111111', searchSelectedForeground: '#222222' },
    });
    term.searchSelect('next');
    r.r.setSearchHighlights(read());
    r.r.render(term, true, 0, live.provider, 0);
    const glyphs = (color: string) => r.shown().filter((v) => v.startsWith(`${color} `));
    expect(glyphs('#111111').length).toBeGreaterThan(0);
    expect(glyphs('#222222').length).toBeGreaterThan(0);
    term.free();
  });
});
