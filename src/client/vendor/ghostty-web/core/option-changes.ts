// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// What an option set after open() changes (util): the engine's default cursor, the
// renderer's font, or the grid size; xterm.js lets options change at runtime (ADR 061).

import type { GhosttyTerminal } from '../engine/engine-types';
import type { TerminalOptionValues } from './options-proxy';

/** What an option change reaches: the open terminal's engine and renderer, and its steps. */
export interface OptionChangeHost {
  /** The options, the changed one already set. */
  options(): Pick<
    TerminalOptionValues,
    'cursorStyle' | 'cursorBlink' | 'fontSize' | 'fontFamily' | 'cols' | 'rows'
  >;
  engine(): Pick<GhosttyTerminal, 'setDefaultCursor'> | undefined;
  renderer(): { setFontSize(size: number): void; setFontFamily(family: string): void } | undefined;
  /** The cell size changed: the canvas follows it and every row is drawn again. */
  fontChanged(): void;
  resize(cols: number, rows: number): void;
}

/**
 * Applies `key`'s change from `oldValue` to `newValue`; setting the value an option already
 * has does nothing. `disableStdin` and the options read as they are used need nothing.
 */
export function applyOptionChange(
  key: keyof TerminalOptionValues,
  newValue: unknown,
  oldValue: unknown,
  host: OptionChangeHost,
): void {
  if (newValue === oldValue) return;
  const options = host.options();
  const renderer = host.renderer();
  switch (key) {
    case 'cursorBlink':
    case 'cursorStyle':
      // The engine's default; the renderer draws what the engine reports (webtty, ADR 049)
      host.engine()?.setDefaultCursor(options.cursorStyle, options.cursorBlink);
      break;
    case 'theme':
      if (renderer) {
        console.warn('ghostty-web: theme changes after open() are not yet fully supported');
      }
      break;
    case 'fontSize':
      if (renderer) {
        renderer.setFontSize(options.fontSize);
        host.fontChanged();
      }
      break;
    case 'fontFamily':
      if (renderer) {
        renderer.setFontFamily(options.fontFamily);
        host.fontChanged();
      }
      break;
    case 'cols':
    case 'rows':
      host.resize(options.cols, options.rows);
      break;
  }
}
