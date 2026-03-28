import type { Terminal } from 'ghostty-web';

// ghostty-web does not yet read cursor style from the WASM render state after
// write() — getCursor() hardcodes style: 'block' (see TODO in ghostty-web source).
// As a workaround, we intercept DECSCUSR sequences (CSI Ps SP q) from PTY output
// and apply them directly via the options proxy, which forwards to the renderer.
//
// DECSCUSR codes (ECMA-48 / DEC):
//   0, 1 — blinking block (0 = default)
//   2    — steady block
//   3    — blinking underline
//   4    — steady underline
//   5    — blinking bar
//   6    — steady bar
//
// config.cursorStyle sets the initial shape at startup; PTY sequences override
// it at runtime. The two compose cleanly: config is your default, apps (vim,
// fish normal mode, etc.) switch dynamically as needed.

const ESC = '\x1b';
const DECSCUSR = new RegExp(`${ESC}\\[(\\d*) q`, 'g');

/**
 * Scans `data` for DECSCUSR sequences (`CSI Ps SP q`) and applies matching cursor
 * style/blink changes directly to `term.options`, then forces a full repaint so the
 * previous cursor shape is cleared before the new one is drawn.
 *
 * ghostty-web does not yet propagate cursor style from PTY output — this is a
 * client-side workaround until the WASM layer handles it natively.
 */
export function applyDecscusr(term: Terminal, data: string): void {
  const initialStyle = term.options.cursorStyle;
  const initialBlink = term.options.cursorBlink;
  DECSCUSR.lastIndex = 0;
  let match = DECSCUSR.exec(data);
  while (match !== null) {
    const ps = match[1] === '' ? 0 : Number(match[1]);
    if (!Number.isNaN(ps) && ps >= 0 && ps <= 6) {
      term.options.cursorStyle =
        ps === 0 || ps === 1 || ps === 2 ? 'block' : ps === 3 || ps === 4 ? 'underline' : 'bar';
      term.options.cursorBlink = ps === 0 || ps === 1 || ps === 3 || ps === 5;
    }
    match = DECSCUSR.exec(data);
  }
  // ghostty-web's render loop only clears the cursor row when the cursor moves or
  // cursorBlink is true. When switching to a non-blinking style (e.g. block→bar in
  // vim normal→insert), the old cursor shape stays painted on canvas and the new
  // shape is drawn on top — leaving a ghost of the previous cursor.
  //
  // Force a full repaint so the cursor row is cleared before the new shape is drawn.
  // term.renderer and term.wasmTerm are public on Terminal; forceAll=true repaints
  // every row, which clears the stale cursor, and renderCursor() draws the new shape.
  if (
    (term.options.cursorStyle !== initialStyle || term.options.cursorBlink !== initialBlink) &&
    term.renderer &&
    term.wasmTerm
  ) {
    term.renderer.render(term.wasmTerm, true, term.viewportY);
  }
}
