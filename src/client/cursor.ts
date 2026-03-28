import type { Terminal } from 'ghostty-web';

// ghostty-web does not yet read cursor style from the WASM render state after
// write() — getCursor() hardcodes style: 'block' (see TODO in ghostty-web source).
// As a workaround, we intercept DECSCUSR sequences (CSI Ps SP q) from PTY output
// and apply them directly via the options proxy, which forwards to the renderer.
//
// TODO (post ghostty-web WASM rebuild): once coder/ghostty-web#147 is merged and
// the WASM binary is rebuilt with the new ghostty_render_state_get_cursor_style /
// ghostty_render_state_get_cursor_blinking exports, getCursor() will return live
// values from the WASM state. At that point:
//   1. Delete cursor.ts entirely.
//   2. Remove `import { applyDecscusr } from './cursor'` from index.ts.
//   3. Remove the `applyDecscusr(term, event.data)` call in ws.onmessage.
// The upstream fix makes the client-side intercept redundant.
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
