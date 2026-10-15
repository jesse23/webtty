import { describe, expect, test } from 'bun:test';
import type { RowSource } from '../../ghostty-web/render/frame-lines';
import { ScrollTracker } from '../../ghostty-web/render/scroll-tracker';

/** A 4-row source with `dirty` rows and `scrollbackLength` lines above the screen. */
function source(dirty: number[], scrollbackLength = 10): RowSource {
  return {
    buffer: { isRowDirty: (y: number) => dirty.includes(y) } as unknown as RowSource['buffer'],
    getLine: () => null,
    rows: 4,
    scrollback: undefined,
    scrollbackLength,
  };
}

describe('ScrollTracker', () => {
  test('a frame forced in full does not scan the dirty rows', () => {
    const tracker = new ScrollTracker();
    expect(tracker.track(source([1]), 0, 0, true)).toEqual({
      dirtyRows: [],
      linesMoved: true,
      repaintAll: true,
    });
  });

  // Each row: the previous frame (viewportY, scrollback), this frame, the dirty rows, and
  // what the tracker reports
  test.each([
    ['nothing changed at the bottom', [0, 10], [0, 10], [], false, false],
    ['dirty rows at the bottom repaint as dirty', [0, 10], [0, 10], [1, 3], true, false],
    ['new scrollback at the bottom', [0, 10], [0, 11], [], true, false],
    ['new scrollback while scrolled', [2, 10], [2, 11], [], true, true],
    ['a dirty row while scrolled', [2, 10], [2, 10], [0], true, false],
    ['every row dirty while scrolled', [2, 10], [2, 10], [0, 1, 2, 3], true, true],
    ['a whole-line move alone', [0, 10], [3, 10], [], false, false],
    ['a whole-line move with output', [0, 10], [3, 10], [0], true, true],
    ['a fractional viewportY', [0, 10], [0.5, 10], [], false, true],
    ['from a fractional viewportY', [0.5, 10], [1, 10], [], false, true],
  ] as const)('%s', (_name, [lastY, lastSb], [y, sb], dirty, linesMoved, repaintAll) => {
    const tracker = new ScrollTracker();
    tracker.track(source([], lastSb), lastY, Math.floor(lastY), false);
    const moves = tracker.track(source([...dirty], sb), y, Math.floor(y), false);
    expect(moves).toEqual({ dirtyRows: [...dirty], linesMoved, repaintAll });
  });
});
