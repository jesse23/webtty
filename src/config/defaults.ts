// The built-in configuration every missing key falls back to. A constants module; the shell
// default is read from the environment once, when the module loads (ADR 062).
import type { Config, KeyboardBinding, RightClickBehavior, Theme } from './config-schema';

/** The shell new sessions run when the config sets none: `%COMSPEC%` on Windows, `$SHELL` elsewhere. */
export function defaultShell(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  return platform === 'win32' ? (env.COMSPEC ?? 'cmd.exe') : (env.SHELL ?? '/bin/bash');
}

/** The Campbell palette, used for every theme key the config file leaves out. */
export const DEFAULT_THEME: Theme = {
  background: '#000000',
  foreground: '#CCCCCC',
  cursor: '#FFFFFF',
  selection: '#FFFFFF',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  purple: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightPurple: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2',
};

/** No bindings ship by default; user bindings are merged over this list by `(key, mods)`. */
export const DEFAULT_KEYBOARD_BINDINGS: KeyboardBinding[] = [];

/** The full configuration used when the file sets nothing; loadConfig spreads the parsed keys over it. */
export const DEFAULT_CONFIG: Config = {
  port: 2346,
  host: '127.0.0.1',
  shell: defaultShell(),
  term: 'xterm-256color',
  colorTerm: 'truecolor',
  scrollback: 256 * 1024,
  scrollbackLines: 10000,
  cols: 80,
  rows: 24,
  fontSize: 13,
  // 'STIX Two Text' comes last: it fills only clusters no earlier font covers whole,
  // such as a letter with an enclosing mark (a⃝, U+20DD), which Menlo lacks.
  fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'",
  cursorStyle: 'bar',
  cursorStyleBlink: true,
  copyOnSelect: true,
  rightClickBehavior: 'contextMenu' as RightClickBehavior,
  clipboardWrite: true,
  bellTitle: true,
  desktopNotifications: true,
  mouseScrollSpeed: 1,
  padding: 0,
  logs: false,
  theme: DEFAULT_THEME,
  keyboardBindings: DEFAULT_KEYBOARD_BINDINGS,
  env: {},
};
