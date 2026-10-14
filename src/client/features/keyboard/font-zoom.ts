// The font zoom keys and the size each one sets (util, pure, ADR 060): Ctrl/Cmd with +, -
// or 0, as VS Code binds them, within the range a terminal cell stays usable in.

/** The smallest font size zoom goes to. */
export const MIN_FONT_SIZE = 6;
/** The largest font size zoom goes to. */
export const MAX_FONT_SIZE = 32;

/** What a zoom key does. */
export type FontZoomStep = 'in' | 'out' | 'reset';

/** The key fields a zoom key is read from. */
export type ZoomKeyEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** `size` within [MIN_FONT_SIZE, MAX_FONT_SIZE]. */
export function clampFontSize(size: number): number {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

/**
 * The zoom step a keydown is, if any. `e.code` is the physical key, so the keys work on
 * any layout; + needs no Shift, and Shift with - or 0 (`_`, `)`) is not a zoom.
 */
export function zoomStepFor(e: ZoomKeyEvent): FontZoomStep | null {
  if (!e.ctrlKey && !e.metaKey) return null;
  if (e.code === 'Equal' || e.code === 'NumpadAdd') return 'in';
  if ((e.code === 'Minus' && !e.shiftKey) || e.code === 'NumpadSubtract') return 'out';
  if ((e.code === 'Digit0' && !e.shiftKey) || e.code === 'Numpad0') return 'reset';
  return null;
}

/**
 * The size after `step`, one point at a time; reset goes back to the configured size.
 * The configured size is clamped too, so one outside the range never inverts the
 * direction of the first step.
 */
export function zoomedFontSize(step: FontZoomStep, current: number, configured: number): number {
  if (step === 'in') return Math.min(MAX_FONT_SIZE, current + 1);
  if (step === 'out') return Math.max(MIN_FONT_SIZE, current - 1);
  return clampFontSize(configured);
}
