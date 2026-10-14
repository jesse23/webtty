import { describe, expect, test } from 'bun:test';
import { LinkDetector } from '../../ghostty-web/link-detector';
import type { ILink, ILinkProvider } from '../../ghostty-web/link-types';

// LinkDetector on a fake buffer: the inclusive range hit test, provider precedence, the
// row scan cache and dispose.

/** A buffer of `rows` rows of `cols` cells. */
function fakeTerminal(cols: number, rows: number) {
  const cell = { getHyperlinkId: () => 0 };
  return {
    buffer: {
      active: {
        getLine: (y: number) =>
          y >= 0 && y < rows
            ? { length: cols, getCell: (x: number) => (x < cols ? cell : undefined) }
            : undefined,
      },
    },
  };
}

function link(text: string, sx: number, sy: number, ex: number, ey: number): ILink {
  return { text, range: { start: { x: sx, y: sy }, end: { x: ex, y: ey } }, activate: () => {} };
}

/** A provider returning `links` for the rows they start on, counting its calls. */
function provider(links: ILink[]) {
  const calls: number[] = [];
  let disposed = 0;
  const p: ILinkProvider = {
    provideLinks: (y, callback) => {
      calls.push(y);
      const found = links.filter((l) => l.range.start.y === y);
      callback(found.length ? found : undefined);
    },
    dispose: () => {
      disposed++;
    },
  };
  return { p, calls, disposed: () => disposed };
}

describe('LinkDetector', () => {
  test('finds a link spanning rows by the inclusive range', async () => {
    const detector = new LinkDetector(fakeTerminal(10, 4));
    const wrapped = link('https://x', 7, 1, 2, 2);
    detector.registerProvider(provider([wrapped]).p);
    expect(await detector.getLinkAt(6, 1)).toBeUndefined();
    expect(await detector.getLinkAt(7, 1)).toBe(wrapped);
    expect(await detector.getLinkAt(9, 1)).toBe(wrapped);
    // Row 2 has not been scanned: the cache from row 1 answers
    expect(await detector.getLinkAt(2, 2)).toBe(wrapped);
    expect(await detector.getLinkAt(3, 2)).toBeUndefined();
  });

  test('scans a row once until the cache is invalidated', async () => {
    const detector = new LinkDetector(fakeTerminal(10, 4));
    const { p, calls } = provider([]);
    detector.registerProvider(p);
    await detector.getLinkAt(0, 0);
    await detector.getLinkAt(1, 0);
    expect(calls).toEqual([0]);
    detector.invalidateCache();
    await detector.getLinkAt(1, 0);
    expect(calls).toEqual([0, 0]);
  });

  test('an earlier provider wins the same range', async () => {
    const detector = new LinkDetector(fakeTerminal(10, 2));
    const first = link('osc8', 0, 0, 3, 0);
    detector.registerProvider(provider([first]).p);
    detector.registerProvider(provider([link('regex', 0, 0, 3, 0)]).p);
    expect(await detector.getLinkAt(2, 0)).toBe(first);
  });

  test('returns nothing outside the buffer', async () => {
    const detector = new LinkDetector(fakeTerminal(10, 2));
    const { p, calls } = provider([link('x', 0, 0, 9, 0)]);
    detector.registerProvider(p);
    expect(await detector.getLinkAt(-1, 0)).toBeUndefined();
    expect(await detector.getLinkAt(10, 0)).toBeUndefined();
    expect(await detector.getLinkAt(0, 5)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('dispose disposes the providers and forgets them', async () => {
    const detector = new LinkDetector(fakeTerminal(10, 2));
    const a = provider([link('x', 0, 0, 9, 0)]);
    detector.registerProvider(a.p);
    expect(await detector.getLinkAt(0, 0)).toBeDefined();
    detector.dispose();
    expect(a.disposed()).toBe(1);
    expect(await detector.getLinkAt(0, 0)).toBeUndefined();
    detector.dispose();
    expect(a.disposed()).toBe(1);
  });
});
