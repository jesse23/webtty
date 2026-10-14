// Derived from coder/ghostty-web lib/types.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The engine's narrow interfaces (types): what the split parts of the vendored layer import
// instead of the binding's classes (ADR 061). For now the terminal's creation config.

/**
 * Terminal configuration, applied when the terminal is created. Colours are
 * 0xRRGGBB; undefined leaves one unset, so 0 is black. (webtty, ADR 047)
 */
export interface GhosttyTerminalConfig {
  /**
   * History in lines, with a 32 MiB ceiling; 0 = no line limit. Default 10,000.
   * (webtty, ADR 046)
   */
  scrollbackLines?: number;
  fgColor?: number;
  bgColor?: number;
  cursorColor?: number;
  /** The 16 ANSI colours; an undefined entry keeps Ghostty's default. */
  palette?: (number | undefined)[];
  /**
   * The default cursor shape and blink, which DECSCUSR Ps 0 and RIS restore. Default
   * block, not blinking. (webtty, ADR 049)
   */
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  /**
   * Whether programs may write the clipboard (OSC 52, OSC 1337 Copy, OSC 5522): the
   * writes are reported by `readEffects`. Off, Ghostty's clipboard write callback is
   * left unset and the writes are ignored. Default true. (webtty, ADR 052)
   */
  clipboardWrite?: boolean;
  /**
   * Whether programs may ask for desktop notifications (OSC 9, OSC 777 `notify`): they
   * are reported by `readEffects`. Off, Ghostty's desktop notification callback is left
   * unset and the requests are ignored. Default true. (webtty, ADR 056)
   */
  desktopNotifications?: boolean;
}
