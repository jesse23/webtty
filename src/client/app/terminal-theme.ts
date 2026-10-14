/**
 * Maps webtty's theme keys onto the names ghostty-web understands.
 *
 * webtty follows Windows Terminal's names (`purple`, `brightPurple`, `selection`) while
 * ghostty-web's `ITheme` uses xterm.js names (`magenta`, `brightMagenta`,
 * `selectionBackground`, `selectionForeground`). Keys it does not know are ignored, so
 * without this mapping ANSI purple and the selection colour fall back to ghostty-web's own
 * defaults (`#bc3fbc`, and a light-gray selection with dark text). See ADR 036.
 */

export interface ThemeKeys {
  background?: string;
  foreground?: string;
  cursor?: string;
  selection?: string;
  selectionForeground?: string;
  padding?: string;
  purple?: string;
  brightPurple?: string;
  [ansiKey: string]: string | undefined;
}

export function toTerminalTheme(themeConfig: object): Record<string, string> {
  const theme = themeConfig as ThemeKeys;
  const {
    padding: _padding,
    purple,
    brightPurple,
    selection,
    selectionForeground,
    ...rest
  } = theme;
  const mapped: Record<string, string | undefined> = {
    ...rest,
    magenta: purple,
    brightMagenta: brightPurple,
    selectionBackground: selection,
    // Ghostty's own rule: the selected text takes the background colour, unless a
    // selection foreground is given. Without `selection` ghostty-web's defaults apply.
    selectionForeground:
      selectionForeground ?? (selection !== undefined ? theme.background : undefined),
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
