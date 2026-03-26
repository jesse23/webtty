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

export function applyDecscusr(term: Terminal, data: string): void {
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
}
