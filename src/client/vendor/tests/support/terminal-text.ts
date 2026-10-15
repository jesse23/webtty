// Readers and colours shared by the engine tests (test support, ADR 064): a row's text as
// an app sees it, on screen and in scrollback, the 0xRRGGBB of a decoded cell, and the
// theme most engine tests create their terminals with.

import type { GhosttyCell, GhosttyTerminal } from '../../ghostty-web/ghostty';

/** The theme's default foreground. */
export const FG = 0xd4d4d4;
/** The theme's default background. */
export const BG = 0x1e1e1e;
/** Palette entry 1. */
export const RED = 0xcd3131;
/** Palette entry 4. */
export const BLUE = 0x2472c8;
/** The config most engine tests create their terminals with. */
export const THEME = {
  fgColor: FG,
  bgColor: BG,
  palette: [0x000000, RED, 0x0dbc79, 0xe5e510, BLUE],
};

function cellsText(cells: GhosttyCell[], grapheme: (x: number) => string): string {
  return cells
    .map((c, x) => {
      if (c.width === 0) return '';
      if (c.grapheme_len > 0) return grapheme(x);
      return c.codepoint ? String.fromCodePoint(c.codepoint) : ' ';
    })
    .join('')
    .trimEnd();
}

/** The text of a row as an app would see it: graphemes joined, spacer cells skipped. */
export function rowText(t: GhosttyTerminal, y: number): string {
  const line = t.getLine(y);
  return line ? cellsText(line, (x) => t.getGraphemeString(y, x)) : '';
}

/** The text of scrollback row `offset` (0 is the oldest), as `rowText` reads it. */
export function scrollbackText(t: GhosttyTerminal, offset: number): string {
  const line = t.getScrollbackLine(offset);
  return line ? cellsText(line, (x) => t.getScrollbackGraphemeString(offset, x)) : '';
}

/** A cell's foreground as 0xRRGGBB. */
export const rgb = (c: { fg_r: number; fg_g: number; fg_b: number }) =>
  (c.fg_r << 16) | (c.fg_g << 8) | c.fg_b;

/** A cell's background as 0xRRGGBB. */
export const bgRgb = (c: { bg_r: number; bg_g: number; bg_b: number }) =>
  (c.bg_r << 16) | (c.bg_g << 8) | c.bg_b;

/** `n` lines `line 1` … `line n`, joined by CRLF. */
export const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n');

/** A command as fish 4 marks it with OSC 133 (ADR 057): prompt, command line, output, end. */
export const markedCommand = (name: string, outputLines: number) =>
  `\x1b]133;A\x07$ \x1b]133;B\x07${name}\r\n\x1b]133;C\x07` +
  Array.from({ length: outputLines }, (_, i) => `${name} ${i}`).join('\r\n') +
  '\r\n\x1b]133;D;0\x07';

/** On a 20x5 grid: prompts on rows 0, 7 and 14, and the current one on row 21 of 22. */
export const markedSession = () =>
  `${markedCommand('one', 6)}${markedCommand('two', 6)}${markedCommand('three', 6)}\x1b]133;A\x07$ `;
