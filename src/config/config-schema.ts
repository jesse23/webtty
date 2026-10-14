// The shape of webtty's configuration: the Config type and its parts, plus the one list of
// keys the client may see. A types module with a single constant tuple; the client imports
// it with `import type` only (ADR 062, architecture SPEC "Contracts across the client/server line").

/** A single keyboard binding: intercepts `key`+`mods` and sends `chars` to the PTY. */
export interface KeyboardBinding {
  /** Key name matched case-insensitively against `KeyboardEvent.key` (e.g. `"enter"`, `"arrowup"`, `"a"`). */
  key: string;
  /** Modifier keys that must be active — and no others — for this binding to match. Accepted values: `"shift"`, `"ctrl"`, `"alt"`, `"meta"`. Order irrelevant. Unknown values are filtered out at config load time. */
  mods?: string[];
  /** Byte sequence sent verbatim to the PTY. Standard JSON escapes apply (`\r`, `\uXXXX`, etc.). */
  chars: string;
}

/** Terminal color palette. All keys are optional; omitted keys fall back to the Campbell defaults. */
export interface Theme {
  /** Terminal background. */
  background?: string;
  /** Default text color. */
  foreground?: string;
  /** Cursor color. */
  cursor?: string;
  /** Selection highlight (background). */
  selection?: string;
  /** Text colour inside the selection. Defaults to `background`. */
  selectionForeground?: string;
  /** Background of find matches (ADR 055). Defaults to Ghostty's `#FFE082`. */
  searchBackground?: string;
  /** Text colour of find matches. Defaults to `#000000`. */
  searchForeground?: string;
  /** Background of the selected find match. Defaults to Ghostty's `#F2A57E`. */
  searchSelectedBackground?: string;
  /** Text colour of the selected find match. Defaults to `#000000`. */
  searchSelectedForeground?: string;
  /** Colour of the padding set by the `padding` setting. Defaults to `background`. The sub-cell leftover from fitting is not coloured by this: the client extends the edge cells' own background into it. */
  padding?: string;
  /** ANSI 0. */
  black?: string;
  /** ANSI 1. */
  red?: string;
  /** ANSI 2. */
  green?: string;
  /** ANSI 3. */
  yellow?: string;
  /** ANSI 4. */
  blue?: string;
  /** ANSI 5. */
  purple?: string;
  /** ANSI 6. */
  cyan?: string;
  /** ANSI 7. */
  white?: string;
  /** ANSI 8. */
  brightBlack?: string;
  /** ANSI 9. */
  brightRed?: string;
  /** ANSI 10. */
  brightGreen?: string;
  /** ANSI 11. */
  brightYellow?: string;
  /** ANSI 12. */
  brightBlue?: string;
  /** ANSI 13. */
  brightPurple?: string;
  /** ANSI 14. */
  brightCyan?: string;
  /** ANSI 15. */
  brightWhite?: string;
}

/**
 * What a right-click does when the app does not take it (it takes it while it tracks the
 * mouse, unless Shift is held): `"contextMenu"` shows the browser menu; `"copyPaste"`
 * copies and clears a selection, or shows the menu without one; `"paste"` pastes the
 * clipboard; `"none"` does nothing. See ADR 051.
 */
export type RightClickBehavior = 'contextMenu' | 'copyPaste' | 'paste' | 'none';

/** Full webtty configuration. All keys are optional in the config file; missing keys fall back to {@link DEFAULT_CONFIG}. */
export interface Config {
  /** HTTP listen port; env `PORT` takes precedence. */
  port: number;
  /** Bind address; use `"0.0.0.0"` for remote access. */
  host: string;
  /** Shell for new sessions. */
  shell: string;
  /** `$TERM` env var passed to the shell. Fixed to `xterm-256color` — the PTY child talks to webtty, not to the parent terminal. */
  term: string;
  /** `$COLORTERM` env var passed to the shell. */
  colorTerm: string;
  /** PTY history buffer in bytes; used for server-side replay on reload/reconnect. The client does not read it. */
  scrollback: number;
  /** Terminal history in lines; `0` = no line limit. History is also capped at 32 MiB. See ADR 046. */
  scrollbackLines: number;
  /** Initial terminal width in columns. */
  cols: number;
  /** Initial terminal height in rows. */
  rows: number;
  /** Font size in px. */
  fontSize: number;
  /** CSS font-family stack. */
  fontFamily: string;
  /** Default cursor shape. Apps override at runtime via DECSCUSR — this is the startup default only. */
  cursorStyle: 'block' | 'bar' | 'underline';
  /** Default blink state. Apps override at runtime via DECSCUSR — this is the startup default only. */
  cursorStyleBlink: boolean;
  /** Copy a mouse selection to the clipboard when the button is released (kitty / Windows Terminal style). A drag the app receives is not a selection. */
  copyOnSelect: boolean;
  /** What a right-click does when the app does not take it; see {@link RightClickBehavior}. */
  rightClickBehavior: RightClickBehavior;
  /** Let programs write the clipboard with OSC 52 (write only: reads are never answered). `false` ignores the writes. */
  clipboardWrite: boolean;
  /** Put a 🔔 in front of the tab title when a program rings the bell (BEL), until the terminal is focused or a key is pressed, as Ghostty's `bell-features = title`. Bells replayed on reconnect are ignored. */
  bellTitle: boolean;
  /** Let programs show desktop notifications with OSC 9 and OSC 777, as Ghostty's `desktop-notifications`: shown while the terminal is not focused, once the browser grants permission. Notifications replayed on reconnect are ignored. `false` ignores them. */
  desktopNotifications: boolean;
  /** Mouse wheel scroll speed multiplier for apps with mouse tracking. `1` = one SGR per tick. Values `< 1` reduce rate; values `> 1` send multiple SGRs per tick. Must be `> 0`. */
  mouseScrollSpeed: number;
  /** Padding in px around the terminal canvas, on all four sides. `0` = none. Coloured by `theme.padding`, or `theme.background` if that is unset. */
  padding: number;
  /** Write server stdout/stderr to `~/.config/webtty/server.log`. Appends on each start. */
  logs: boolean;
  /** Terminal color palette. */
  theme: Theme;
  /** Custom key-to-sequence bindings. Merged with built-in defaults by `(key, mods)` identity. */
  keyboardBindings: KeyboardBinding[];
  /** Additional environment variables injected into PTY shells and execute commands. Merges over `process.env`; `TERM` and `COLORTERM` always take precedence for PTY spawns. */
  env: Record<string, string>;
}

/**
 * The keys `GET /api/config` sends to the browser, in the order they are sent. Server-only
 * keys (port, host, shell, term, colorTerm, logs, env) stay out. `scrollback` is legacy: the
 * client no longer reads it, but it is still sent so the response is unchanged.
 */
export const CLIENT_CONFIG_KEYS = [
  'cols',
  'rows',
  'fontSize',
  'fontFamily',
  'cursorStyle',
  'cursorStyleBlink',
  'scrollback',
  'scrollbackLines',
  'theme',
  'copyOnSelect',
  'rightClickBehavior',
  'clipboardWrite',
  'bellTitle',
  'desktopNotifications',
  'mouseScrollSpeed',
  'padding',
  'keyboardBindings',
] as const satisfies readonly (keyof Config)[];

/** One key of {@link CLIENT_CONFIG_KEYS}. */
export type ClientConfigKey = (typeof CLIENT_CONFIG_KEYS)[number];

/** The client-safe view of {@link Config} served by `GET /api/config`; the one type the server and the browser share. */
export type ClientConfig = Pick<Config, ClientConfigKey>;
