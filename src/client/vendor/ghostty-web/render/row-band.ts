// webtty (ADR 043, ADR 061), not from upstream.
// The overscan band and the canvas row states (util): which lines the canvas rows hold,
// whether each row's pixels are as a full redraw leaves them, and which runs to repaint.
// Called once per frame and per changed row; nothing here allocates except the shifts.

/**
 * Rows drawn above and below the viewport, so pixel-smooth scrolling moves the canvas
 * across lines without drawing (webtty, ADR 043). At least 1: the row above the
 * viewport shows while it is at a fraction of a line.
 */
export const DEFAULT_OVERSCAN = 16;

/** A canvas row whose pixels must be drawn before it is shown. */
export const ROW_INVALID = 0;
/** A row with its own cells plus what the next line draws into it, as a full redraw leaves a row. */
export const ROW_JOINED = 1;
/** A row with its own cells only, as a full redraw leaves the last row. */
export const ROW_CUT = 2;

/**
 * Whether canvas rows drawn for viewportY `band` still hold every row in view at
 * viewportY `view`, including the row `above` (1 at a fraction of a line, else 0).
 * Canvas row k shows viewport row k - overscan at viewportY `band`.
 */
export function bandFits(band: number, view: number, overscan: number, above: number): boolean {
  return band - view <= overscan && overscan + band - view - above >= 0;
}

/**
 * The band the next frame draws for. The canvas rows are kept while the rows in view are
 * among them. Otherwise they are drawn for a viewportY half the overscan further in the
 * direction of the move, so the next moves that way stay within them, clamped to the
 * scrollback, or for `view` itself when that does not fit either.
 */
export function nextBand(
  band: number,
  view: number,
  overscan: number,
  above: number,
  scrollbackLength: number
): number {
  if (bandFits(band, view, overscan, above)) return band;
  const ahead = Math.sign(view - band) * Math.floor(overscan / 2);
  const next = Math.max(0, Math.min(Math.max(scrollbackLength, view), view + ahead));
  return bandFits(next, view, overscan, above) ? next : view;
}

/** Row states after the canvas content moved down by `shift` rows; rows that came in are invalid. */
export function shiftedRowStates(state: Uint8Array, shift: number): Uint8Array {
  const total = state.length;
  const shifted = new Uint8Array(total);
  for (let k = Math.max(0, -shift); k < Math.min(total, total - shift); k++) {
    shifted[k + shift] = state[k];
  }
  return shifted;
}

/** Per-row keys (`total` of them) after the same move; rows that came in get ''. */
export function shiftedRowKeys(keys: string[], shift: number, total: number): string[] {
  const shifted = new Array<string>(total).fill('');
  for (let k = Math.max(0, -shift); k < Math.min(total, total - shift); k++) {
    shifted[k + shift] = keys[k] ?? '';
  }
  return shifted;
}

/** Marks row `k` invalid: its own pixels changed (an overlay over it). Out of range is ignored. */
export function invalidateRow(state: Uint8Array, k: number): void {
  if (k >= 0 && k < state.length) state[k] = ROW_INVALID;
}

/**
 * Marks row `k` changed: its content or highlight changed, so it is invalid, and so is
 * the row above when it holds row k's overflow.
 */
export function changeRow(state: Uint8Array, k: number): void {
  invalidateRow(state, k);
  if (k > 0 && k <= state.length && state[k - 1] === ROW_JOINED) state[k - 1] = ROW_INVALID;
}

/** Marks every row outside the `rows` rows from `top` invalid: the lines moved under them. */
export function invalidateOutOfView(state: Uint8Array, top: number, rows: number): void {
  for (let k = 0; k < state.length; k++) {
    if (k < top || k >= top + rows) state[k] = ROW_INVALID;
  }
}

/**
 * The state a full redraw of the viewport leaves canvas row `k` in, the viewport being
 * rows `top` to `last`: its last row and the row above it have nothing drawn into them
 * from below.
 */
export function wantedRowState(k: number, top: number, last: number): number {
  return k === last || k < top ? ROW_CUT : ROW_JOINED;
}

/**
 * The last row of the run that repaints row `k` (which is not as wanted): a joined row
 * is repainted with the rows below it that are not as wanted either, up to `last`.
 */
export function repaintRunEnd(state: Uint8Array, k: number, top: number, last: number): number {
  let end = k;
  while (
    end < last &&
    wantedRowState(end, top, last) === ROW_JOINED &&
    state[end + 1] !== wantedRowState(end + 1, top, last)
  ) {
    end++;
  }
  return end;
}
