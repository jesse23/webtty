import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BufferNamespace } from './ghostty-web/buffer';
import { Ghostty } from './ghostty-web/ghostty';
import type { Terminal } from './ghostty-web/terminal';

const WASM = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ghostty-vt/ghostty-vt-small.wasm',
);

// The buffer API is what the link providers and the kitty graphics read: the
// cursor, the line count, and each cell's codepoint and hyperlink id.
describe('BufferNamespace', () => {
  test('reads the cursor, scrollback and screen lines, codepoints and links', async () => {
    const ghostty = await Ghostty.load(WASM);
    const wasmTerm = ghostty.createTerminal(10, 2);
    wasmTerm.write('old\r\nmid\r\n\x1b]8;;https://a.b\x1b\\ln\x1b]8;;\x1b\\k');
    const buffer = new BufferNamespace({ wasmTerm } as unknown as Terminal);
    const active = buffer.active;
    expect(active.type).toBe('normal');
    expect(active.length).toBe(3);
    expect([active.cursorX, active.cursorY]).toEqual([3, 1]);
    const text = (y: number) => {
      const line = active.getLine(y);
      if (!line) return undefined;
      return Array.from({ length: 3 }, (_, x) =>
        String.fromCodePoint(line.getCell(x)?.getCodepoint() || 32),
      ).join('');
    };
    expect([text(0), text(1), text(2), text(3)]).toEqual(['old', 'mid', 'lnk', undefined]);
    const links = Array.from({ length: 3 }, (_, x) =>
      active.getLine(2)?.getCell(x)?.getHyperlinkId(),
    );
    expect(links.map((id) => (id ?? 0) > 0)).toEqual([true, true, false]);
    expect(active.getLine(2)?.getCell(10)).toBeUndefined();
    wasmTerm.write('\x1b[?1049h');
    expect(buffer.active.type).toBe('alternate');
    expect(buffer.active.length).toBe(2);
    wasmTerm.free();
  });
});
