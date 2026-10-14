import { afterEach, describe, expect, test } from 'bun:test';
import { openLinkOnModifier, windowOpen } from '../../ghostty-web/providers/open-link';

// The one link activation rule: Ctrl or Cmd opens a new tab without an opener.

describe('openLinkOnModifier', () => {
  test.each([
    [{ ctrlKey: false, metaKey: false }, []],
    [{ ctrlKey: true, metaKey: false }, [['u', '_blank', 'noopener,noreferrer']]],
    [{ ctrlKey: false, metaKey: true }, [['u', '_blank', 'noopener,noreferrer']]],
  ])('a click with %j opens %j', (event, expected) => {
    const opened: string[][] = [];
    openLinkOnModifier('u', event, (...args) => opened.push(args));
    expect(opened).toEqual(expected);
  });
});

describe('windowOpen', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.window;

  afterEach(() => {
    g.window = saved;
  });

  test("calls the page's window.open, read when a link opens", () => {
    const calls: unknown[][] = [];
    g.window = { open: (...args: unknown[]) => calls.push(args) };
    windowOpen('u', '_blank', 'f');
    openLinkOnModifier('v', { ctrlKey: true, metaKey: false });
    expect(calls).toEqual([
      ['u', '_blank', 'f'],
      ['v', '_blank', 'noopener,noreferrer'],
    ]);
  });
});
