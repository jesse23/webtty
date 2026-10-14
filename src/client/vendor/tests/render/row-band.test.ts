import { describe, expect, test } from 'bun:test';
import {
  bandFits,
  changeRow,
  invalidateOutOfView,
  invalidateRow,
  nextBand,
  ROW_CUT,
  ROW_INVALID,
  ROW_JOINED,
  repaintRunEnd,
  shiftedRowKeys,
  shiftedRowStates,
  wantedRowState,
} from '../../ghostty-web/render/row-band';

// The overscan band plan and the canvas row states, table-driven, then checked against a
// full redraw over random scroll and output sequences.

const I = ROW_INVALID;
const J = ROW_JOINED;
const C = ROW_CUT;

describe('bandFits', () => {
  test.each([
    ['the band at the view', 5, 5, 4, 0, true],
    ['the view a whole overscan below the band', 9, 5, 4, 0, true],
    ['the view past the overscan below', 10, 5, 4, 0, false],
    ['the view a whole overscan above the band', 1, 5, 4, 0, true],
    ['the view an overscan above, with the row above shown', 1, 5, 4, 1, false],
    ['the view past the overscan above', 0, 5, 4, 0, false],
  ])('%s', (_name, band, view, overscan, above, fits) => {
    expect(bandFits(band, view, overscan, above)).toBe(fits);
  });
});

describe('nextBand', () => {
  test.each([
    ['kept while it fits', 10, 12, 4, 0, 100, 10],
    ['moved half the overscan ahead, scrolling up', 10, 20, 4, 0, 100, 22],
    ['moved half the overscan ahead, scrolling down', 20, 10, 4, 0, 100, 8],
    ['clamped to the scrollback', 80, 99, 4, 0, 100, 100],
    ['clamped to 0', 20, 1, 4, 0, 100, 0],
    ['past the scrollback the view itself is the limit', 0, 30, 4, 0, 10, 30],
    ['the view itself when ahead does not fit', 0, 5, 1, 1, 100, 5],
  ])('%s', (_name, band, view, overscan, above, scrollback, next) => {
    expect(nextBand(band, view, overscan, above, scrollback)).toBe(next);
    expect(bandFits(next, view, overscan, above)).toBe(true);
  });
});

describe('shifting rows', () => {
  test.each([
    [2, [I, I, J, C, J]],
    [-2, [J, C, J, I, I]],
    [0, [J, C, J, C, J]],
    [5, [I, I, I, I, I]],
    [-7, [I, I, I, I, I]],
  ])('row states moved %p rows', (shift, shifted) => {
    expect([...shiftedRowStates(Uint8Array.from([J, C, J, C, J]), shift)]).toEqual(shifted);
  });

  test.each([
    [1, 4, ['', 'a', 'b', 'c']],
    [-1, 4, ['b', 'c', '', '']],
    [1, 2, ['', 'a']],
  ])('keys moved %p rows into %p rows', (shift, total, shifted) => {
    expect(shiftedRowKeys(['a', 'b', 'c'], shift, total)).toEqual(shifted);
  });
});

describe('marking rows', () => {
  test.each([
    ['a row', 2, [J, J, I, J]],
    ['before the canvas', -1, [J, J, J, J]],
    ['past the canvas', 4, [J, J, J, J]],
  ])('invalidateRow: %s', (_name, k, after) => {
    const state = Uint8Array.from([J, J, J, J]);
    invalidateRow(state, k);
    expect([...state]).toEqual(after);
  });

  test.each([
    ['a row and the joined row above', [J, J, J, J], 2, [J, I, I, J]],
    ['a row under a cut row', [J, C, J, J], 2, [J, C, I, J]],
    ['the first row', [J, J, J, J], 0, [I, J, J, J]],
    [
      'the row just past the canvas: the last row holds its overflow',
      [J, J, J, J],
      4,
      [J, J, J, I],
    ],
    ['far past the canvas', [J, J, J, J], 6, [J, J, J, J]],
  ])('changeRow: %s', (_name, before, k, after) => {
    const state = Uint8Array.from(before);
    changeRow(state, k);
    expect([...state]).toEqual(after);
  });

  test('invalidateOutOfView keeps only the rows in view', () => {
    const state = Uint8Array.from([J, J, J, J, C, J]);
    invalidateOutOfView(state, 2, 3);
    expect([...state]).toEqual([I, I, J, J, C, I]);
  });
});

describe('repaint runs', () => {
  test.each([
    ['above the viewport', 1, C],
    ['the first row in view', 2, J],
    ['a middle row', 3, J],
    ['the last row', 5, C],
  ])('wantedRowState: %s', (_name, k, wanted) => {
    expect(wantedRowState(k, 2, 5)).toBe(wanted);
  });

  // The viewport is rows 2 to 5, the row above it row 1
  test.each([
    ['one row whose next row is as wanted', [I, C, I, J, J, C], 2, 2],
    ['a run up to a row as wanted', [I, C, I, I, J, C], 2, 3],
    ['a run to the last row', [I, C, I, I, I, I], 2, 5],
    ['the row above stops at itself', [I, I, I, I, I, I], 1, 1],
    ['the last row', [I, C, J, J, J, I], 5, 5],
  ])('repaintRunEnd: %s', (_name, state, k, end) => {
    expect(repaintRunEnd(Uint8Array.from(state), k, 2, 5)).toBe(end);
  });
});

/** A seeded random number generator, so a failing sequence can be replayed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * What one canvas row's pixels show: its own line at a version and, when joined, what the
 * next line at a version draws into it. null: nothing drawn.
 */
type Pixels = { own: string; next: string | null } | null;

/**
 * Plans frames as the renderer does, over a model of the canvas rows' pixels, and
 * checks that every row in view shows exactly what a full redraw of the viewport would.
 */
function simulate(seed: number, frames: number) {
  const rng = random(seed);
  const rows = 6;
  const overscan = 4;
  const total = rows + 2 * overscan;
  const scrollback = 40;
  const version = new Array<number>(scrollback + rows).fill(0);
  // The line canvas row k shows at band b: viewport row k - overscan at viewportY b
  const lineAt = (k: number, b: number) => scrollback - b + k - overscan;
  const text = (line: number) =>
    line >= 0 && line < version.length ? `${line}@${version[line]}` : 'blank';

  let state: Uint8Array = new Uint8Array(total);
  let pixels: Pixels[] = new Array(total).fill(null);
  let band = 0;
  let lastView = 0;
  let repaints = 0;
  let shifts = 0;

  for (let frame = 0; frame < frames; frame++) {
    // Mostly small scrolls, sometimes a jump; output only at the bottom
    const r = rng();
    let view = lastView;
    if (r < 0.5) view += Math.round((rng() - 0.5) * 6);
    else if (r < 0.6) view = Math.floor(rng() * (scrollback + 1));
    view = Math.max(0, Math.min(scrollback, view));
    const above = view < scrollback && rng() < 0.3 ? 1 : 0;
    const dirty = view === 0 && rng() < 0.3 ? [Math.floor(rng() * rows)] : [];
    for (const y of dirty) version[scrollback + y]++;

    let force = frame === 0;
    const moved = view !== lastView;
    if (dirty.length > 0 && moved) force = true;
    lastView = view;

    if (force) {
      band = view;
    } else {
      const next = nextBand(band, view, overscan, above, scrollback);
      const shift = next - band;
      if (Math.abs(shift) >= total) {
        force = true;
      } else if (shift !== 0) {
        shifts++;
        state = shiftedRowStates(state, shift);
        const moved: Pixels[] = new Array(total).fill(null);
        for (let k = 0; k < total; k++) {
          if (k + shift >= 0 && k + shift < total) moved[k + shift] = pixels[k];
        }
        pixels = moved;
      }
      band = next;
    }
    expect(bandFits(band, view, overscan, above)).toBe(true);
    const top = overscan + band - view;
    if (force) state.fill(ROW_INVALID);
    else {
      for (const y of dirty) changeRow(state, top + y);
      if (dirty.length > 0) invalidateOutOfView(state, top, rows);
    }

    const first = top - above;
    const last = top + rows - 1;
    for (let k = first; k <= last; k++) {
      if (state[k] === wantedRowState(k, top, last)) continue;
      const end = repaintRunEnd(state, k, top, last);
      const cut = wantedRowState(end, top, last) === ROW_CUT;
      for (let j = k; j <= end; j++) {
        const joined = j < end || !cut;
        pixels[j] = { own: text(lineAt(j, band)), next: joined ? text(lineAt(j + 1, band)) : null };
        state[j] = ROW_JOINED;
        repaints++;
      }
      state[end] = cut ? ROW_CUT : ROW_JOINED;
      k = end;
    }

    // A full redraw of the viewport: each row its own line, joined with the next line
    // except the last row and the row above
    for (let k = first; k <= last; k++) {
      const joined = wantedRowState(k, top, last) === ROW_JOINED;
      const want = { own: text(lineAt(k, band)), next: joined ? text(lineAt(k + 1, band)) : null };
      if (JSON.stringify(pixels[k]) !== JSON.stringify(want)) {
        throw new Error(
          `seed ${seed} frame ${frame}: row ${k} shows ${JSON.stringify(pixels[k])}, want ${JSON.stringify(want)}`,
        );
      }
      expect(state[k]).toBe(wantedRowState(k, top, last));
    }
  }
  return { repaints, shifts };
}

describe('random scroll and output sequences', () => {
  test('every frame shows what a full redraw shows', () => {
    let repaints = 0;
    let shifts = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const result = simulate(seed, 200);
      repaints += result.repaints;
      shifts += result.shifts;
    }
    // The band saved work: far fewer rows were drawn than a full redraw per frame would
    expect(shifts).toBeGreaterThan(0);
    expect(repaints).toBeLessThan(40 * 200 * 6);
  });
});
