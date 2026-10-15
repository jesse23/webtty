import { describe, expect, test } from 'bun:test';
import type { ILink } from '../../ghostty-web/link-types';
import {
  type ITerminalForOSC8Provider,
  OSC8LinkProvider,
} from '../../ghostty-web/providers/osc8-link-provider';

// OSC8LinkProvider on a fake buffer: hyperlinked runs grouped by URI, the screen and
// scrollback lookups, and activation.

/**
 * A buffer of `uris` rows, one URI (or null for no link) per cell, whose first
 * `scrollback` rows are scrollback; lookups are logged.
 */
function terminal(uris: (string | null)[][], scrollback: number, engine = true) {
  const log: string[] = [];
  const t: ITerminalForOSC8Provider = {
    buffer: {
      active: {
        length: uris.length,
        getLine: (y) =>
          uris[y] && {
            length: uris[y].length,
            getCell: (x) =>
              x < uris[y].length ? { getHyperlinkId: () => (uris[y][x] ? 1 : 0) } : undefined,
          },
      },
    },
  };
  if (engine) {
    t.wasmTerm = {
      getScrollbackLength: () => scrollback,
      getHyperlinkUri: (row, col) => {
        log.push(`screen ${row},${col}`);
        return uris[row + scrollback][col];
      },
      getScrollbackHyperlinkUri: (offset, col) => {
        log.push(`scrollback ${offset},${col}`);
        return uris[offset][col];
      },
    };
  }
  return { t, log };
}

function provide(t: ITerminalForOSC8Provider, y: number, opened: string[] = []) {
  const provider = new OSC8LinkProvider(t, (url) => opened.push(url));
  let found: ILink[] | undefined;
  provider.provideLinks(y, (links) => {
    found = links;
  });
  return found;
}

const A = 'https://a.example';
const B = 'https://b.example';

describe('OSC8LinkProvider', () => {
  test('groups neighbouring cells with the same URI into one link per run', () => {
    const { t } = terminal([[null, A, A, B, B, null, A]], 0);
    expect(provide(t, 0)?.map((link) => [link.text, link.range.start.x, link.range.end.x])).toEqual(
      [
        [A, 1, 2],
        [B, 3, 4],
        [A, 6, 6],
      ],
    );
  });

  test('reads a screen row through the screen lookup, by its viewport row', () => {
    const { t, log } = terminal([[null], [A, A]], 1);
    expect(provide(t, 1)?.[0].range).toEqual({ start: { x: 0, y: 1 }, end: { x: 1, y: 1 } });
    expect(log).toEqual(['screen 0,0', 'screen 0,1']);
  });

  test('reads a scrollback row through the scrollback lookup, by its buffer row', () => {
    const { t, log } = terminal([[B, B], [null]], 1);
    expect(provide(t, 0)?.map((link) => link.text)).toEqual([B]);
    expect(log).toEqual(['scrollback 0,0', 'scrollback 0,1']);
  });

  test('a cell marked as a link with no URI, a row without links, or a missing row has none', () => {
    const marked = terminal([[A]], 0);
    if (marked.t.wasmTerm) marked.t.wasmTerm.getHyperlinkUri = () => null;
    expect(provide(marked.t, 0)).toBeUndefined();
    expect(provide(terminal([[null, null]], 0).t, 0)).toBeUndefined();
    expect(provide(terminal([], 0).t, 2)).toBeUndefined();
  });

  test('without the engine nothing is found', () => {
    expect(provide(terminal([[A]], 0, false).t, 0)).toBeUndefined();
  });

  test('a run ends at a missing cell', () => {
    const { t } = terminal([[A, A, A]], 0);
    const line = t.buffer.active.getLine(0);
    t.buffer.active.getLine = () => ({
      length: 3,
      getCell: (x) => (x === 1 ? undefined : line?.getCell(x)),
    });
    expect(provide(t, 0)?.map((link) => [link.range.start.x, link.range.end.x])).toEqual([
      [0, 0],
      [2, 2],
    ]);
  });

  test('activating a link opens it only with Ctrl or Cmd held', () => {
    const opened: string[] = [];
    const [link] = provide(terminal([[A]], 0).t, 0, opened) ?? [];
    link.activate({ ctrlKey: false, metaKey: false } as MouseEvent);
    link.activate({ ctrlKey: false, metaKey: true } as MouseEvent);
    expect(opened).toEqual([A]);
    new OSC8LinkProvider(terminal([], 0).t).dispose();
  });
});
