// Tells a physical mouse wheel from a trackpad by its recent pixel deltas (object, ADR 045).
// Adapted from VS Code's `MouseWheelClassifier` (src/vs/base/browser/ui/scrollbar/
// scrollableElement.ts), Copyright (c) Microsoft Corporation, MIT License.

/**
 * Scores each pixel delta as wheel-like or trackpad-like and weighs the latest ones, so
 * `WheelStream` can tell a mouse wheel's notches from a trackpad's smooth deltas.
 */
export class WheelClassifier {
  private static readonly CAPACITY = 5;
  /** Scores of the latest events, newest last: 0 looks like a wheel, 1 like a trackpad. */
  private scores: number[] = [];
  private previous: { deltaX: number; deltaY: number } | null = null;

  /** Takes one pixel delta (a `deltaMode` 0 event) into the recent history. */
  accept(deltaX: number, deltaY: number): void {
    this.scores.push(this.score(deltaX, deltaY));
    if (this.scores.length > WheelClassifier.CAPACITY) this.scores.shift();
    this.previous = { deltaX, deltaY };
  }

  /** The newest score weighs 1/2, the next 1/4, and so on; the oldest takes the rest. */
  isPhysicalMouseWheel(): boolean {
    if (this.scores.length === 0) return false;
    let remaining = 1;
    let total = 0;
    for (let i = this.scores.length - 1; i >= 0; i--) {
      const influence = i === 0 ? remaining : 2 ** -(this.scores.length - i);
      remaining -= influence;
      total += this.scores[i] * influence;
    }
    return total <= 0.5;
  }

  private score(deltaX: number, deltaY: number): number {
    // Both axes at once: a trackpad.
    if (deltaX !== 0 && deltaY !== 0) return 1;
    let score = 0.5;
    if (!isAlmostInt(deltaX) || !isAlmostInt(deltaY)) score += 0.25;
    // A wheel's notches are multiples of each other; a trackpad accelerates smoothly.
    const prev = this.previous;
    if (prev && isMultiple(deltaX, prev.deltaX) && isMultiple(deltaY, prev.deltaY)) score -= 0.5;
    return Math.min(Math.max(score, 0), 1);
  }
}

/**
 * Whether the larger of two deltas is a whole multiple of the smaller (taken as at least 1),
 * by their ratio: at a browser zoom other than 100%, Chromium divides a notch's pixels by the
 * zoom, and notches of 90.909… and 181.818… px leave a remainder in floating point though
 * one is twice the other. (webtty: VS Code compares remainders, after multiplying by its own
 * zoom factor, which a page cannot read.)
 */
function isMultiple(a: number, b: number): boolean {
  const low = Math.max(Math.min(Math.abs(a), Math.abs(b)), 1);
  const ratio = Math.max(Math.abs(a), Math.abs(b)) / low;
  return Math.abs(ratio - Math.round(ratio)) < 0.01;
}

function isAlmostInt(value: number): boolean {
  return Math.abs(Math.round(value) - value) < 0.01 + Number.EPSILON * 100;
}
