// The benchmark's measures as pure functions over numbers: how two recorded frames' row
// brightness profiles line up, blinks (transient frames), paint rate and gaps from frame
// timestamps, scroll step size, and the streaming test's at-bottom and at-rest counts
// (util; the page decodes frames into profiles, page.ts).

/** A frame's mean brightness per pixel row, top to bottom. */
export type Profile = ArrayLike<number>;

/** How a profile is compared with the next: shifts tried, and rows skipped at each edge. */
export interface ShiftWindow {
  maxShift: number;
  margin: number;
}

/** The best vertical alignment of two frames: its mean row error and its shift in px. */
export interface ShiftMatch {
  error: number;
  shift: number;
}

/**
 * The scroll test's window for an input whose view moves at most `maxShift` px between two
 * recorded frames; the margin keeps every shifted row inside the frame.
 */
export function scrollWindow(maxShift: number): ShiftWindow {
  return { maxShift, margin: maxShift + 10 };
}
/**
 * The streaming test's window: it compares frames at rest, where any move is a fault, so
 * a few rows' worth of shift is enough to tell a move from a redraw.
 */
export const STREAM_WINDOW: ShiftWindow = { maxShift: 40, margin: 60 };
/** A mean row error above this is a different picture, not JPEG noise. */
export const DIFFERENT = 3;

/**
 * The shift of `b` against `a` with the least mean error over the rows inside the margin;
 * ties keep the first shift tried, from `-maxShift` up. Throws when the margin is narrower
 * than the largest shift or leaves no rows to compare.
 */
export function bestShift(a: Profile, b: Profile, window: ShiftWindow): ShiftMatch {
  const { maxShift, margin } = window;
  if (margin < maxShift) throw new Error(`shift window: margin ${margin} < maxShift ${maxShift}`);
  if (a.length <= 2 * margin) throw new Error(`shift window: a ${a.length} px frame is too short`);
  let best: ShiftMatch = { error: Number.POSITIVE_INFINITY, shift: 0 };
  for (let s = -maxShift; s <= maxShift; s++) {
    let sum = 0;
    let rows = 0;
    for (let y = margin; y < a.length - margin; y++) {
      sum += Math.abs(b[y] - a[y - s]);
      rows++;
    }
    const error = sum / rows;
    if (error < best.error) best = { error, shift: s };
  }
  return best;
}

/** The best match of each frame against the one before it; entry k is frame k + 1's. */
export function matchPairs(profiles: readonly Profile[], window: ShiftWindow): ShiftMatch[] {
  return profiles.slice(1).map((p, k) => bestShift(profiles[k], p, window));
}

/**
 * The frames that blink: a different picture from both neighbours at any shift, while the
 * neighbours match each other (an error within DIFFERENT, and under half the smaller of the
 * two). Smooth motion never counts, nor do three frames that all differ (an app redrawing),
 * but a flashed or half-drawn frame does. `pairs` is `matchPairs(profiles, window)`.
 */
export function blinkFrames(
  profiles: readonly Profile[],
  pairs: readonly ShiftMatch[],
  window: ShiftWindow,
): number[] {
  const blinks: number[] = [];
  for (let k = 1; k + 1 < profiles.length; k++) {
    const before = pairs[k - 1].error;
    const after = pairs[k].error;
    if (before <= DIFFERENT || after <= DIFFERENT) continue;
    const across = bestShift(profiles[k - 1], profiles[k + 1], window).error;
    if (across <= DIFFERENT && across < Math.min(before, after) / 2) blinks.push(k);
  }
  return blinks;
}

/**
 * The mean distance of the frames that moved, in px (0 when none did). A pair counts only
 * when it is the same picture moved: not a different one (a redraw or a cut), and not at
 * the window's edge, where the real step may have been larger than the window.
 */
export function averageStepPx(pairs: readonly ShiftMatch[], window: ShiftWindow): number {
  const moved = pairs.filter(
    (p) => p.shift !== 0 && p.error <= DIFFERENT && Math.abs(p.shift) < window.maxShift,
  );
  if (moved.length === 0) return 0;
  return round(moved.reduce((sum, p) => sum + Math.abs(p.shift), 0) / moved.length, 1);
}

/** One animation frame from the page's paint counter: its time and whether it drew. */
export type PaintFrame = readonly [time: number, drew: boolean];

/** How often the canvas painted while scrolling, and the gaps between paints in ms. */
export interface PaintStats {
  paintsPerSec: number;
  gapMedian: number;
  gapP90: number;
}

/**
 * Paint stats from the first wheel event to `tailMs` after the last, counting only the
 * animation frames that drew.
 */
export function paintStats(
  frames: readonly PaintFrame[],
  wheels: readonly number[],
  tailMs = 200,
): PaintStats {
  if (wheels.length === 0) return { paintsPerSec: 0, gapMedian: 0, gapP90: 0 };
  const start = wheels[0];
  const end = wheels[wheels.length - 1] + tailMs;
  const painted = frames.filter(([t, drew]) => drew && t >= start && t <= end).map(([t]) => t);
  const gaps = painted
    .slice(1)
    .map((t, i) => t - painted[i])
    .sort((a, b) => a - b);
  const at = (q: number) => Math.round(gaps[Math.floor(gaps.length * q)] ?? 0);
  return {
    paintsPerSec: round(painted.length / ((end - start) / 1000), 1),
    gapMedian: at(0.5),
    gapP90: at(0.9),
  };
}

/** A recorded frame of the streaming test: when it came and how it looked. */
export interface StreamFrame {
  time: number;
  profile: Profile;
}

/** The streaming test's counts, split at the end of the scroll plus a settle time. */
export interface StreamStats {
  framesDuringScroll: number;
  atBottomDuringScroll: number;
  framesAtRest: number;
  atBottomAtRest: number;
  restFramesThatMoved: number;
}

/** The inverse status bar is the only row this bright, so it shows the view is at the bottom. */
export const BAR_BRIGHTNESS = 150;

/** Whether the frame shows the inverse status bar, the bottom of the stream. */
export function atBottom(profile: Profile): boolean {
  for (let y = 0; y < profile.length; y++) if (profile[y] > BAR_BRIGHTNESS) return true;
  return false;
}

/**
 * Counts frames at the bottom during and after the scroll back, and at-rest frames that
 * moved or changed from the one before (the view should hold still while output comes).
 */
export function streamStats(
  frames: readonly StreamFrame[],
  scrollEnd: number,
  settleMs = 300,
): StreamStats {
  const restFrom = scrollEnd + settleMs;
  const during = frames.filter((f) => f.time <= restFrom);
  const rest = frames.filter((f) => f.time > restFrom);
  let moved = 0;
  for (let k = 1; k < frames.length; k++) {
    if (frames[k].time <= restFrom) continue;
    const match = bestShift(frames[k - 1].profile, frames[k].profile, STREAM_WINDOW);
    if (match.shift !== 0 || match.error > DIFFERENT) moved++;
  }
  return {
    framesDuringScroll: during.length,
    atBottomDuringScroll: during.filter((f) => atBottom(f.profile)).length,
    framesAtRest: rest.length,
    atBottomAtRest: rest.filter((f) => atBottom(f.profile)).length,
    restFramesThatMoved: moved,
  };
}

/** The median of `values` (the mean of the middle two for an even count), or 0 for none. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
