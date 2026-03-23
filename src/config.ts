import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stripJsonComments from 'strip-json-comments';

export interface Theme {
  background?: string;
  foreground?: string;
  cursor?: string;
  selection?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  purple?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightPurple?: string;
  brightCyan?: string;
  brightWhite?: string;
}

export interface Config {
  port: number;
  host: string;
  shell: string;
  term: string;
  colorTerm: string;
  scrollback: number;
  cols: number;
  rows: number;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  theme: Theme;
}

function getConfigPath(): string {
  return path.join(os.homedir(), '.config', 'webtty', 'config.jsonc');
}

export const DEFAULT_THEME: Theme = {
  background: '#282A36',
  foreground: '#F8F8F2',
  cursor: '#F8F8F2',
  selection: '#44475A',
  black: '#21222C',
  red: '#FF5555',
  green: '#50FA7B',
  yellow: '#F1FA8C',
  blue: '#BD93F9',
  purple: '#FF79C6',
  cyan: '#8BE9FD',
  white: '#F8F8F2',
  brightBlack: '#6272A4',
  brightRed: '#FF6E6E',
  brightGreen: '#69FF94',
  brightYellow: '#FFFFA5',
  brightBlue: '#D6ACFF',
  brightPurple: '#FF92DF',
  brightCyan: '#A4FFFF',
  brightWhite: '#FFFFFF',
};

export const DEFAULT_CONFIG: Config = {
  port: 2346,
  host: '127.0.0.1',
  shell:
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash'),
  term: process.env.TERM ?? 'xterm-256color',
  colorTerm: 'truecolor',
  scrollback: 256 * 1024,
  cols: 80,
  rows: 24,
  fontSize: 14,
  fontFamily: "'FiraMono Nerd Font', Menlo, Monaco, 'Courier New', monospace",
  cursorBlink: true,
  theme: DEFAULT_THEME,
};

export function loadConfig(): Config {
  if (!fs.existsSync(getConfigPath())) {
    try {
      saveConfig(DEFAULT_CONFIG);
    } catch (err) {
      console.warn(
        `webtty: failed to write default config to ${getConfigPath()}: ${(err as Error).message}`,
      );
      return { ...DEFAULT_CONFIG };
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(getConfigPath(), 'utf8');
  } catch (err) {
    throw new Error(`webtty: failed to read config at ${getConfigPath()}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    throw new Error(`webtty: invalid JSON in config file ${getConfigPath()}`);
  }

  const p = parsed as Partial<Config>;
  return {
    ...DEFAULT_CONFIG,
    ...(typeof p.port === 'number' && { port: p.port }),
    ...(typeof p.host === 'string' && { host: p.host }),
    ...(typeof p.shell === 'string' && { shell: p.shell }),
    ...(typeof p.term === 'string' && { term: p.term }),
    ...(typeof p.scrollback === 'number' && { scrollback: p.scrollback }),
    ...(typeof p.cols === 'number' && { cols: p.cols }),
    ...(typeof p.rows === 'number' && { rows: p.rows }),
    ...(typeof p.fontSize === 'number' && { fontSize: p.fontSize }),
    ...(typeof p.fontFamily === 'string' && { fontFamily: p.fontFamily }),
    ...(typeof p.cursorBlink === 'boolean' && { cursorBlink: p.cursorBlink }),
    ...(p.theme && typeof p.theme === 'object' && { theme: { ...DEFAULT_THEME, ...p.theme } }),
  };
}

export function saveConfig(_config: Config): void {
  const th = DEFAULT_THEME;
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  const content = [
    '{',
    '  // Server',
    '  // HTTP listen port; env PORT takes precedence',
    '  "port": 2346,',
    '  // Bind address; use "0.0.0.0" for remote access',
    '  "host": "127.0.0.1"',
    '',
    '  // Shell',
    '  // Shell for new sessions; defaults to $COMSPEC / cmd.exe on Windows, $SHELL / /bin/bash on Unix',
    '  // "shell": "/bin/zsh",',
    '  // $TERM env var passed to the shell; defaults to $TERM from environment',
    '  // "term": "xterm-256color",',
    '',
    '  // Terminal',
    '  // PTY history buffer in bytes; used for server-side replay on reload/reconnect',
    '  // "scrollback": 262144,',
    '  // Initial terminal width in columns',
    '  // "cols": 80,',
    '  // Initial terminal height in rows',
    '  // "rows": 24,',
    '  // Whether the cursor blinks',
    '  // "cursorBlink": true,',
    '  // Font size in px',
    '  // "fontSize": 14,',
    '  // CSS font-family stack',
    '  // "fontFamily": "\'FiraMono Nerd Font\', Menlo, Monaco, \'Courier New\', monospace",',
    '',
    '  // Theme — terminal color palette, Dracula by default',
    '  // "theme": {',
    `  //   "background":   "${th.background}",  // terminal background`,
    `  //   "foreground":   "${th.foreground}",  // default text color`,
    `  //   "cursor":       "${th.cursor}",  // cursor color`,
    `  //   "selection":    "${th.selection}",  // selection highlight`,
    `  //   "black":        "${th.black}",  // ANSI 0`,
    `  //   "red":          "${th.red}",  // ANSI 1`,
    `  //   "green":        "${th.green}",  // ANSI 2`,
    `  //   "yellow":       "${th.yellow}",  // ANSI 3`,
    `  //   "blue":         "${th.blue}",  // ANSI 4`,
    `  //   "purple":       "${th.purple}",  // ANSI 5`,
    `  //   "cyan":         "${th.cyan}",  // ANSI 6`,
    `  //   "white":        "${th.white}",  // ANSI 7`,
    `  //   "brightBlack":  "${th.brightBlack}",  // ANSI 8`,
    `  //   "brightRed":    "${th.brightRed}",  // ANSI 9`,
    `  //   "brightGreen":  "${th.brightGreen}",  // ANSI 10`,
    `  //   "brightYellow": "${th.brightYellow}",  // ANSI 11`,
    `  //   "brightBlue":   "${th.brightBlue}",  // ANSI 12`,
    `  //   "brightPurple": "${th.brightPurple}",  // ANSI 13`,
    `  //   "brightCyan":   "${th.brightCyan}",  // ANSI 14`,
    `  //   "brightWhite":  "${th.brightWhite}"   // ANSI 15`,
    '  // }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(getConfigPath(), content, 'utf8');
}
