import { describe, expect, test } from 'bun:test';
import { FindController } from '../../ghostty-web/core/find-controller';
import type { FindHost } from '../../ghostty-web/core/host-types';
import { FIND_READ_BACKOFF } from '../../ghostty-web/core/terminal-constants';
import type { SearchState } from '../../ghostty-web/ghostty';
import type { SearchHighlights } from '../../ghostty-web/search';
import { loadGhostty } from '../support/wasm';

// Find on libghostty-vt's search, stepped frame by frame as the render loop does (ADR 055):
// the count, the highlights, the view taken to a match and kept on it, and the read backoff.

/** A FindController on a real 20x4 engine; the host records what it is handed. */
async function finder() {
  const ghostty = await loadGhostty();
  const engine = ghostty.createTerminal(20, 4, { scrollbackLines: 1000 });
  const highlights: (SearchHighlights | null)[] = [];
  const states: SearchState[] = [];
  const view = { y: 0 };
  // The clock moves on by `readMs` at each reading, so a read of the matches takes that long
  let clock = 0;
  let readMs = 0;
  const host: FindHost = {
    engine: () => engine,
    highlight: (h) => highlights.push(h),
    getScrollbackLength: () => engine.getScrollbackLength(),
    viewportY: () => view.y,
    rows: () => 4,
    scrollToLine: (line) => {
      view.y = line;
    },
    changed: (state) => states.push(state),
  };
  const find = new FindController(host, () => {
    clock += readMs;
    return clock;
  });
  let now = 0;
  /** Render-loop frames, a second apart. */
  const frames = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 1000;
      find.step(now);
    }
  };
  const lastState = () => states[states.length - 1];
  const last = () => highlights[highlights.length - 1];
  return {
    engine,
    find,
    host,
    view,
    frames,
    states,
    highlights,
    lastState,
    last,
    readTakes: (ms: number) => {
      readMs = ms;
    },
  };
}

describe('FindController', () => {
  test('finds in its steps, reports the count, and highlights every match', async () => {
    const { engine, find, frames, lastState, last } = await finder();
    for (let i = 0; i < 20; i++) engine.write(i % 5 === 0 ? `Error ${i}\r\n` : `ok ${i}\r\n`);
    expect(find.finding).toBe(false);
    find.find('error');
    expect(find.finding).toBe(true);
    // A new search clears the old highlights at once
    expect(last()).toBeNull();
    frames(3);
    expect(lastState()).toEqual({ total: 4, selected: null });
    expect(last()?.matches.length).toBe(16);
    expect(last()?.selected).toBeNull();
    engine.free();
  });

  test('next scrolls to a match out of view, its first row at the top, and wraps', async () => {
    const { engine, find, view, frames, lastState } = await finder();
    engine.write('needle\r\n');
    for (let i = 0; i < 20; i++) engine.write(`line ${i}\r\n`);
    engine.write('needle');
    find.find('needle');
    frames(2);
    const sb = engine.getScrollbackLength();
    // The newest match is on screen: no scroll
    expect(find.select('next')).toBe(true);
    expect(view.y).toBe(0);
    expect(find.anchored).toBe(true);
    expect(lastState()).toEqual({ total: 2, selected: 0 });
    // The oldest is the first scrollback row
    find.select('next');
    expect(view.y).toBe(sb);
    expect(lastState()).toEqual({ total: 2, selected: 1 });
    find.select('previous');
    expect(view.y).toBe(0);
    engine.free();
  });

  test('with no search open, or no engine, next and previous are not performed', async () => {
    const { engine, find, host } = await finder();
    expect(find.select('next')).toBe(false);
    expect(find.select('previous')).toBe(false);
    find.find('x');
    const lost = new FindController({ ...host, engine: () => undefined });
    lost.find('x');
    expect(lost.select('next')).toBe(false);
    // A step without an engine does nothing
    lost.step(1000);
    engine.free();
  });

  test('a step keeps a scrolled view on its match while output scrolls it', async () => {
    const { engine, find, view, frames } = await finder();
    engine.write('needle\r\n');
    for (let i = 0; i < 20; i++) engine.write(`line ${i}\r\n`);
    find.find('needle');
    frames(2);
    find.select('next');
    expect(view.y).toBe(engine.getScrollbackLength());
    const before = view.y;
    engine.write('more\r\nmore\r\nmore\r\n');
    frames();
    expect(view.y).toBe(before + 3);
    engine.free();
  });

  test('while output keeps changing the matches, a read waits for its backoff', async () => {
    const { engine, find, highlights, readTakes } = await finder();
    // Each read of the matches takes 2 ms: the next one waits 2 * backoff ms
    readTakes(2);
    engine.write('abc');
    find.find('abc');
    find.step(1000);
    const reads = highlights.length;
    engine.write(' abc');
    find.step(1000 + 2 * FIND_READ_BACKOFF - 1);
    expect(highlights.length).toBe(reads);
    find.step(1000 + 2 * FIND_READ_BACKOFF);
    expect(highlights.length).toBe(reads + 1);
    engine.free();
  });

  test('ending the search clears the highlights and the count', async () => {
    const { engine, find, frames, lastState, last } = await finder();
    engine.write('abc abc');
    find.find('abc');
    frames();
    find.select('next');
    frames();
    find.find('');
    expect(find.finding).toBe(false);
    expect(find.anchored).toBe(false);
    expect(last()).toBeNull();
    expect(lastState()).toEqual({ total: 0, selected: null });
    frames();
    expect(last()).toBeNull();
    engine.free();
  });

  test('restart sets the needle again, and does nothing with no search open', async () => {
    const { engine, find, highlights } = await finder();
    find.restart();
    expect(highlights).toEqual([]);
    find.find('abc');
    find.restart();
    expect(highlights).toEqual([null, null]);
    engine.free();
  });

  test('reports only a changed count or selection', async () => {
    const { engine, find, frames, states } = await finder();
    engine.write('abc');
    find.find('abc');
    frames(3);
    find.find('abc');
    frames(3);
    expect(states).toEqual([{ total: 1, selected: null }]);
    engine.free();
  });
});
