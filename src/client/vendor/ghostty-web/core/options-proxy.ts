// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal's options store (util + constants): the defaults, the proxy that reports a
// change made after construction (xterm.js lets options change at runtime), and the
// engine config built from the options (ADR 061).

import type { GhosttyTerminalConfig } from '../engine/engine-types';
import type { ITerminalOptions } from '../interfaces';

/** The options a Terminal keeps: every option but the engine, defaults filled in. */
export type TerminalOptionValues = Required<
  Omit<ITerminalOptions, 'ghostty' | 'scrollbackLines'>
> &
  Pick<ITerminalOptions, 'scrollbackLines'>;

/**
 * The value of each option that is not given. `theme` is `{}` and `scrollbackLines`
 * stays unset (the engine's own default), so neither is listed.
 */
export const TERMINAL_DEFAULTS = {
  cols: 80,
  rows: 24,
  cursorBlink: false,
  cursorStyle: 'block',
  fontSize: 15,
  fontFamily: 'monospace',
  allowTransparency: false,
  convertEol: false,
  disableStdin: false,
  mouseScrollSpeed: 1,
  copyOnSelect: true,
  rightClickBehavior: 'contextMenu',
  clipboardWrite: true,
  desktopNotifications: true,
} as const satisfies Omit<TerminalOptionValues, 'theme' | 'scrollbackLines'>;

/** The options with every unset one at its default, in the order Terminal has always kept them. */
export function withDefaults(options: ITerminalOptions): TerminalOptionValues {
  const d = TERMINAL_DEFAULTS;
  return {
    cols: options.cols ?? d.cols,
    rows: options.rows ?? d.rows,
    cursorBlink: options.cursorBlink ?? d.cursorBlink,
    cursorStyle: options.cursorStyle ?? d.cursorStyle,
    theme: options.theme ?? {},
    scrollbackLines: options.scrollbackLines,
    fontSize: options.fontSize ?? d.fontSize,
    fontFamily: options.fontFamily ?? d.fontFamily,
    allowTransparency: options.allowTransparency ?? d.allowTransparency,
    convertEol: options.convertEol ?? d.convertEol,
    disableStdin: options.disableStdin ?? d.disableStdin,
    mouseScrollSpeed: options.mouseScrollSpeed ?? d.mouseScrollSpeed,
    copyOnSelect: options.copyOnSelect ?? d.copyOnSelect,
    rightClickBehavior: options.rightClickBehavior ?? d.rightClickBehavior,
    clipboardWrite: options.clipboardWrite ?? d.clipboardWrite,
    desktopNotifications: options.desktopNotifications ?? d.desktopNotifications,
  };
}

/** Called after an option is set, with the key, the new value and the one it replaced. */
export type OptionChange<T> = (key: keyof T, value: unknown, oldValue: unknown) => void;

/**
 * Wraps `values` so every assignment is stored and then reported to `onChange`, which
 * applies it (a font size, a resize). Reads go straight to `values`.
 */
export function createOptionsProxy<T extends object>(values: T, onChange: OptionChange<T>): T {
  return new Proxy(values, {
    set: (target, prop, value) => {
      const key = prop as keyof T;
      const oldValue = target[key];
      target[key] = value;
      onChange(key, value, oldValue);
      return true;
    },
  });
}

/**
 * A CSS colour as 0xRRGGBB (`#rgb`, `#rrggbb` or `rgb(r, g, b)`), or undefined when it is
 * unset or invalid. (webtty: replaces `parseColorToHex`, which returned 0 for both; tells
 * `#000000` apart from "not given", ADR 042)
 */
export function parseThemeColor(color?: string): number | undefined {
  if (!color) return undefined;

  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    const value = Number.parseInt(hex, 16);
    return Number.isNaN(value) ? undefined : value;
  }

  const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    const r = Number.parseInt(match[1], 10);
    const g = Number.parseInt(match[2], 10);
    const b = Number.parseInt(match[3], 10);
    return (r << 16) | (g << 8) | b;
  }

  return undefined;
}

/** The options the engine is created with. */
export type EngineOptions = Pick<
  TerminalOptionValues,
  | 'theme'
  | 'scrollbackLines'
  | 'cursorStyle'
  | 'cursorBlink'
  | 'clipboardWrite'
  | 'desktopNotifications'
>;

/** The engine's config for these options: the theme's colours, history, cursor and effects. */
export function toEngineConfig(options: EngineOptions): GhosttyTerminalConfig {
  const theme = options.theme;
  // The 16 ANSI colours in palette order: the 8 normal, then the 8 bright
  const palette = [
    theme?.black,
    theme?.red,
    theme?.green,
    theme?.yellow,
    theme?.blue,
    theme?.magenta,
    theme?.cyan,
    theme?.white,
    theme?.brightBlack,
    theme?.brightRed,
    theme?.brightGreen,
    theme?.brightYellow,
    theme?.brightBlue,
    theme?.brightMagenta,
    theme?.brightCyan,
    theme?.brightWhite,
  ].map((color) => parseThemeColor(color));

  return {
    scrollbackLines: options.scrollbackLines,
    fgColor: parseThemeColor(theme?.foreground),
    bgColor: parseThemeColor(theme?.background),
    cursorColor: parseThemeColor(theme?.cursor),
    palette,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink,
    clipboardWrite: options.clipboardWrite,
    desktopNotifications: options.desktopNotifications,
  };
}
