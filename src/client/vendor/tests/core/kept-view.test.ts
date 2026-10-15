import { afterEach, describe, expect, test } from 'bun:test';
import type { Terminal } from '../../ghostty-web/terminal';
import {
  engineOf,
  openTerminal,
  rendererOf,
  type TerminalHarness,
} from '../support/terminal-harness';
import { scrollbackText } from '../support/terminal-text';

// Output keeps a scrolled-back view on its text (ADR 066), on the real engine: Ghostty's
// viewport pin carries the view through new lines, through the whole pages Ghostty prunes
// at the scrollback limit (ADR 046) and through a cleared scrollback.

let h: TerminalHarness | undefined;

afterEach(() => {
  h?.close();
  h = undefined;
});

/** An 80 × 5 terminal whose scrollback Ghostty prunes a page (hundreds of rows) at a time. */
async function capped() {
  h = await openTerminal({ cols: 80, rows: 5, scrollbackLines: 1500 });
  return h.term;
}

/** The text of the view's top row. */
function topRow(term: Terminal): string {
  const engine = engineOf(term);
  return scrollbackText(engine, engine.getScrollbackLength() - Math.floor(term.viewportY)).trim();
}

let next = 0;
/** Writes `n` numbered lines, a few per write. */
function lines(term: Terminal, n: number) {
  for (let i = 0; i < n; i += 4)
    term.write(`L${next++}\r\nL${next++}\r\nL${next++}\r\nL${next++}\r\n`);
}

describe('a scrolled-back view during output', () => {
  test('keeps its text through new lines and through pages pruned at the scrollback limit', async () => {
    const term = await capped();
    lines(term, 1600);
    term.scrollToLine(40);
    const text = topRow(term);
    const lengths = [term.getScrollbackLength()];
    for (let i = 0; i < 12; i++) {
      lines(term, 100);
      lengths.push(term.getScrollbackLength());
      expect(topRow(term)).toBe(text);
    }
    // Ghostty pruned at least once: the scrollback got shorter by much more than a line
    const drops = lengths.slice(1).map((n, i) => lengths[i] - n);
    expect(Math.max(...drops)).toBeGreaterThan(100);
  });

  test('whose own rows are pruned lands on the oldest line left, as in Ghostty', async () => {
    const term = await capped();
    lines(term, 1600);
    term.scrollToLine(term.getScrollbackLength());
    lines(term, 1200);
    expect(term.viewportY).toBe(term.getScrollbackLength());
  });

  test('goes to the bottom when a clear and a reprint, split across writes, erase it', async () => {
    const term = await capped();
    lines(term, 200);
    term.scrollToLine(30);
    term.write('\x1b[2J');
    term.write('\x1b[H\x1b[');
    term.write('3J');
    expect(term.viewportY).toBe(0);
    lines(term, 12);
    expect(term.viewportY).toBe(0);
  });

  test('stays put on a redraw in place, and on the status line webtty writes itself', async () => {
    const term = await capped();
    lines(term, 200);
    term.scrollToLine(30);
    const text = topRow(term);
    term.write('\x1b[5;1H\x1b[2Kspinner');
    term.write('\r\n\x1b[33m[webtty] reconnecting\x1b[0m\r\n');
    expect(topRow(term)).toBe(text);
  });

  test('less than a line back, the part row in view is kept; the alternate screen drops it', async () => {
    const term = await capped();
    lines(term, 200);
    // A smooth scroll shows part of the row above line 0
    rendererOf(term).setScrollOffset(6);
    const moves: number[] = [];
    term.onScroll((y) => moves.push(y));
    lines(term, 12);
    expect(term.viewportY).toBe(12);
    term.scrollToLine(0);
    term.write('\x1b[?1049h');
    expect(moves).toEqual([0, 0]);
  });
});
