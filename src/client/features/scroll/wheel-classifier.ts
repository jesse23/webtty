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
    if (prev) {
      const [ax, ay] = [Math.abs(deltaX), Math.abs(deltaY)];
      const [px, py] = [Math.abs(prev.deltaX), Math.abs(prev.deltaY)];
      const minX = Math.max(Math.min(ax, px), 1);
      const minY = Math.max(Math.min(ay, py), 1);
      if (Math.max(ax, px) % minX === 0 && Math.max(ay, py) % minY === 0) score -= 0.5;
    }
    return Math.min(Math.max(score, 0), 1);
  }
}

function isAlmostInt(value: number): boolean {
  return Math.abs(Math.round(value) - value) < 0.01 + Number.EPSILON * 100;
}
