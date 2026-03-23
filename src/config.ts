import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stripJsonComments from 'strip-json-comments';

export interface Config {
  port: number;
  host: string;
  shell: string;
  term: string;
  scrollback: number;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'webtty');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.jsonc');

export const DEFAULTS: Config = {
  port: 2346,
  host: '127.0.0.1',
  shell:
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash'),
  term: 'xterm-256color',
  scrollback: 256 * 1024,
};

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULTS);
    return { ...DEFAULTS };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    throw new Error(`webtty: failed to read config at ${CONFIG_PATH}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    throw new Error(`webtty: invalid JSON in config file ${CONFIG_PATH}`);
  }

  const partial = parsed as Partial<Config>;
  return {
    port: typeof partial.port === 'number' ? partial.port : DEFAULTS.port,
    host: typeof partial.host === 'string' ? partial.host : DEFAULTS.host,
    shell: typeof partial.shell === 'string' ? partial.shell : DEFAULTS.shell,
    term: typeof partial.term === 'string' ? partial.term : DEFAULTS.term,
    scrollback: typeof partial.scrollback === 'number' ? partial.scrollback : DEFAULTS.scrollback,
  };
}

export function saveConfig(_config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const template = [
    '{',
    '  // Server',
    '  // HTTP listen port; env PORT takes precedence',
    '  "port": 2346,',
    '  // Bind address; use "0.0.0.0" for remote access',
    '  "host": "127.0.0.1",',
    '',
    '  // Shell',
    '  // Shell for new sessions; defaults to $SHELL / %COMSPEC% if omitted',
    '  // "shell": "/bin/zsh",',
    '  // $TERM env var passed to the shell',
    '  // "term": "xterm-256color",',
    '',
    '  // Terminal',
    '  // PTY history buffer in bytes (256 KB); used for server-side replay on reload/reconnect',
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
    '  //   "background":   "#282A36",  // terminal background',
    '  //   "foreground":   "#F8F8F2",  // default text color',
    '  //   "cursor":       "#F8F8F2",  // cursor color',
    '  //   "selection":    "#44475A",  // selection highlight',
    '  //   "black":        "#21222C",  // ANSI 0',
    '  //   "red":          "#FF5555",  // ANSI 1',
    '  //   "green":        "#50FA7B",  // ANSI 2',
    '  //   "yellow":       "#F1FA8C",  // ANSI 3',
    '  //   "blue":         "#BD93F9",  // ANSI 4',
    '  //   "purple":       "#FF79C6",  // ANSI 5',
    '  //   "cyan":         "#8BE9FD",  // ANSI 6',
    '  //   "white":        "#F8F8F2",  // ANSI 7',
    '  //   "brightBlack":  "#6272A4",  // ANSI 8',
    '  //   "brightRed":    "#FF6E6E",  // ANSI 9',
    '  //   "brightGreen":  "#69FF94",  // ANSI 10',
    '  //   "brightYellow": "#FFFFA5",  // ANSI 11',
    '  //   "brightBlue":   "#D6ACFF",  // ANSI 12',
    '  //   "brightPurple": "#FF92DF",  // ANSI 13',
    '  //   "brightCyan":   "#A4FFFF",  // ANSI 14',
    '  //   "brightWhite":  "#FFFFFF"   // ANSI 15',
    '  // }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(CONFIG_PATH, template, 'utf8');
}
