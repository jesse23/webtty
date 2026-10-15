import { describe, expect, test } from 'bun:test';
import { Viewport } from '../../ghostty-web/core/viewport';

// The view's place in the scrollback: clamped moves, each announced, the scrollbar shown,
// and the view kept on its text across a write with the engine's viewport pin (ADR 066).

function viewport(scrollback = 100) {
  const calls: string[] = [];
  const host = {
    length: scrollback,
    /** Whether a smooth scroll's sub-line offset shows part of the row above. */
    partRow: false,
    getScrollbackLength: () => host.length,
    partRowShown: () => host.partRow,
    scrolled: (y: number) => calls.push(`scroll ${y}`),
    showScrollbar: () => calls.push('show'),
  };
  return { view: new Viewport(host), host, calls };
}

describe('Viewport', () => {
  test('starts at the bottom', () => {
    expect(viewport().view.y).toBe(0);
  });

  test('scrollLines moves up for negative amounts and down for positive ones', () => {
    const { view, calls } = viewport();
    view.scrollLines(-5);
    view.scrollLines(2);
    expect(view.y).toBe(3);
    expect(calls).toEqual(['scroll 5', 'show', 'scroll 3', 'show']);
  });

  test.each([
    [-500, 100],
    [500, 0],
  ])('scrollLines(%p) stops at the end of the scrollback (%p)', (amount, expected) => {
    const { view } = viewport();
    view.y = 50;
    view.scrollLines(amount);
    expect(view.y).toBe(expected);
  });

  test.each([
    [40, 40],
    [-3, 0],
    [1000, 100],
    [2.5, 2.5],
  ])('scrollToLine(%p) shows line %p', (line, expected) => {
    const { view } = viewport();
    view.scrollToLine(line);
    expect(view.y).toBe(expected);
  });

  test('a move that goes nowhere announces nothing', () => {
    const { view, calls } = viewport();
    view.scrollLines(1);
    view.scrollToLine(0);
    view.scrollToBottom();
    expect(calls).toEqual([]);
  });

  test('scrollToBottom returns to the bottom and announces it', () => {
    const { view, calls } = viewport();
    view.scrollToLine(30);
    view.scrollToBottom();
    expect(view.y).toBe(0);
    expect(calls).toEqual(['scroll 30', 'show', 'scroll 0', 'show']);
  });

  test('with no scrollback the scrollbar is not shown', () => {
    const { view, host, calls } = viewport(0);
    // A view left over from before a reset is still brought back
    view.y = 4;
    view.scrollToBottom();
    view.y = 4;
    view.scrollLines(1);
    expect(calls).toEqual(['scroll 0', 'scroll 0']);
    expect(host.length).toBe(0);
  });

  test('scrollToBottom from line 0 is announced only while part of the row above shows', () => {
    const { view, host, calls } = viewport();
    view.scrollToBottom();
    host.partRow = true;
    view.scrollToBottom();
    expect([view.y, calls]).toEqual([0, ['scroll 0', 'show']]);
  });

  test('setting y moves the view without an announcement', () => {
    const { view, calls } = viewport();
    view.y = 7;
    expect(view.y).toBe(7);
    expect(calls).toEqual([]);
  });
});

describe('Viewport.jumpToPrompt', () => {
  // Ghostty's jump_to_prompt (ADR 057): the engine finds the row, the view puts it on top.
  /** An engine whose prompts are on buffer rows `rows`, as promptJumpRow reports them. */
  const engine = (rows: number[], calls: string[]) => ({
    promptJumpRow: (top: number, delta: number) => {
      calls.push(`from ${top} by ${delta}`);
      const above = rows.filter((r) => (delta < 0 ? r < top : r > top));
      const target = delta < 0 ? above[above.length + delta] : above[delta - 1];
      return target ?? top;
    },
  });

  test('moves a prompt to the top row, from the whole row the view starts on', () => {
    const { view, calls } = viewport(17);
    view.y = 2.5;
    view.jumpToPrompt(-1, engine([0, 7, 14], calls));
    // The top row is 17 - floor(2.5) = 15; prompt 14 is two rows of scrollback further back
    expect(calls).toEqual(['from 15 by -1', 'scroll 3', 'show']);
    expect(view.y).toBe(3);
  });

  test('stays where it is with no prompt to go to', () => {
    const { view, calls } = viewport(17);
    view.jumpToPrompt(1, engine([0, 7, 14], calls));
    expect(calls).toEqual(['from 17 by 1']);
    expect(view.y).toBe(0);
  });
});

describe('Viewport.pin', () => {
  // The write moves Ghostty's pinned row with its text; the view follows it (ADR 066).
  /** An engine whose pinned row a write moves to `moved(row)`. */
  function pinEngine(calls: string[], moved: (row: number) => number) {
    let pinned = -1;
    return {
      pinViewport: (row: number) => {
        calls.push(`pin ${row}`);
        pinned = row;
      },
      unpinViewport: () => moved(pinned),
    };
  }

  test('a view at the bottom pins nothing: it follows the output', () => {
    const { view, calls } = viewport(100);
    expect(view.pin(pinEngine(calls, (row) => row))).toBe(false);
    expect(calls).toEqual([]);
  });

  test("pins the view's top row and moves to where the write took it, quietly", () => {
    const { view, host, calls } = viewport(100);
    view.y = 10;
    // The write adds 5 lines and prunes 40 old ones: the row is 35 rows nearer the top
    const engine = pinEngine(calls, (row) => row - 35);
    expect(view.pin(engine)).toBe(true);
    host.length = 65;
    view.unpin(engine);
    expect(calls).toEqual(['pin 90']);
    expect(view.y).toBe(65 - 55);
  });

  test('with part of the row above in view, pins that row; a whole line up from the bottom', () => {
    const { view, host, calls } = viewport(100);
    host.partRow = true;
    const engine = pinEngine(calls, (row) => row);
    view.pin(engine);
    host.length = 103;
    view.unpin(engine);
    expect(calls).toEqual(['pin 99']);
    expect(view.y).toBe(3);
  });

  test('keeps a fraction, and stays within the scrollback when it was cleared', () => {
    const { view, host, calls } = viewport(100);
    view.y = 4.5;
    const engine = pinEngine(calls, () => 0);
    view.pin(engine);
    expect(calls).toEqual(['pin 96']);
    host.length = 0;
    view.unpin(engine);
    expect(view.y).toBe(0);
  });

  test('at the top with part of a row above, there is no row above to pin', () => {
    const { view, host, calls } = viewport(100);
    view.y = 100;
    host.partRow = true;
    const engine = pinEngine(calls, (row) => row);
    view.pin(engine);
    view.unpin(engine);
    expect([calls, view.y]).toEqual([['pin 0'], 100]);
  });
});
