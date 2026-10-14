import { beforeAll, describe, expect, test } from 'bun:test';
import type { Ghostty, OfficialTerminal } from '../../ghostty-web/ghostty';
import { THEME } from '../support/terminal-text';
import { loadGhostty } from '../support/wasm';

// Cells read through Ghostty grid refs (ADR 042, ADR 061): OSC 8 hyperlink URIs on screen
// and in scrollback, tested through OfficialTerminal.

let vt: Ghostty;

beforeAll(async () => {
  vt = await loadGhostty();
});

function term(cols = 40, rows = 10, config: object = THEME): OfficialTerminal {
  return vt.createTerminal(cols, rows, config) as OfficialTerminal;
}

describe('official engine: hyperlinks (ADR 042)', () => {
  test('marks OSC 8 hyperlinks and resolves their URIs on screen and in scrollback', () => {
    const t = term(40, 5);
    t.write('\x1b]8;;https://example.com/a\x1b\\link\x1b]8;;\x1b\\ plain');
    expect((t.getLine(0) ?? []).slice(0, 6).map((c) => c.hyperlink_id)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(t.getHyperlinkUri(0, 0)).toBe('https://example.com/a');
    expect(t.getHyperlinkUri(0, 5)).toBeNull();
    t.write('\r\n'.repeat(10));
    expect(t.getScrollbackLength()).toBeGreaterThan(0);
    expect(t.getScrollbackHyperlinkUri(0, 3)).toBe('https://example.com/a');
    expect(t.getScrollbackHyperlinkUri(0, 6)).toBeNull();
    // Longer than the first buffer tried.
    const long = `https://example.com/${'p'.repeat(1500)}`;
    t.write(`\x1b]8;;${long}\x1b\\long\x1b]8;;\x1b\\`);
    expect(t.getHyperlinkUri(t.getCursor().y, 0)).toBe(long);
    t.free();
  });
});
