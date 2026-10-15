import { describe, expect, test } from 'bun:test';
import { Viewport } from '../../ghostty-web/core/viewport';

// The view's place in the scrollback: clamped moves, each announced, the scrollbar shown.

function viewport(scrollback = 100) {
  const calls: string[] = [];
  const host = {
    length: scrollback,
    getScrollbackLength: () => host.length,
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
