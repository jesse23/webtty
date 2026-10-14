// webtty (ADR 039, ADR 061), not from upstream.
// The device pixel ratio the canvas is drawn at (util): rounded up to a whole ratio, and
// followed as it changes through a re-armed resolution media query.

/**
 * The ratio the canvas is drawn at: the device pixel ratio rounded up to a whole
 * number. A fractional ratio (browser zoom, Windows 125%/150%) would put cell edges
 * between device pixels and make the backing-store size fractional; the browser
 * scales the whole-ratio canvas down instead (coder/ghostty-web#198). Browsers
 * report some whole ratios with float noise (2.0000000298023224), which must not
 * round up to the next whole ratio.
 */
export function wholeDevicePixelRatio(ratio: number | undefined): number {
  return Math.max(1, Math.ceil((ratio || 1) - 1e-3));
}

/**
 * Calls onChange with the new window.devicePixelRatio whenever it changes (moving
 * to a display with a different scale, browser zoom). A resolution media query
 * only matches one ratio, so it is re-armed for each new ratio. Returns a function
 * that stops watching.
 */
export function watchDevicePixelRatio(
  win: Pick<Window, 'devicePixelRatio' | 'matchMedia'>,
  onChange: (ratio: number) => void
): () => void {
  let stop = () => {};
  const arm = () => {
    if (typeof win.matchMedia !== 'function') return;
    const query = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    const listener = () => {
      onChange(win.devicePixelRatio || 1);
      arm();
    };
    query.addEventListener('change', listener, { once: true });
    stop = () => query.removeEventListener('change', listener);
  };
  arm();
  return () => stop();
}
