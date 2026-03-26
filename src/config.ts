import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export type RightClickBehavior = 'default' | 'copyPaste';

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
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorStyleBlink: boolean;
  copyOnSelect: boolean;
  rightClickBehavior: RightClickBehavior;
  logs: boolean;
  theme: Theme;
}

export function configDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), '.config', 'webtty');
}

function getConfigPath(): string {
  return path.join(configDir(), 'config.json');
}

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
  fontSize: 13,
  fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace",
  cursorStyle: 'bar',
  cursorStyleBlink: true,
  copyOnSelect: true,
  rightClickBehavior: 'default' as RightClickBehavior,
  logs: false,
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
    throw new Error(
      `webtty: failed to read config at ${getConfigPath()}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
    ...(typeof p.colorTerm === 'string' && { colorTerm: p.colorTerm }),
    ...(typeof p.scrollback === 'number' && { scrollback: p.scrollback }),
    ...(typeof p.cols === 'number' && { cols: p.cols }),
    ...(typeof p.rows === 'number' && { rows: p.rows }),
    ...(typeof p.fontSize === 'number' && { fontSize: p.fontSize }),
    ...(typeof p.fontFamily === 'string' && { fontFamily: p.fontFamily }),
    ...(typeof p.cursorStyle === 'string' &&
      (p.cursorStyle === 'block' || p.cursorStyle === 'bar' || p.cursorStyle === 'underline') && {
        cursorStyle: p.cursorStyle,
      }),
    ...(typeof p.cursorStyleBlink === 'boolean' && { cursorStyleBlink: p.cursorStyleBlink }),
    ...(typeof p.copyOnSelect === 'boolean' && { copyOnSelect: p.copyOnSelect }),
    ...(typeof p.rightClickBehavior === 'string' && {
      rightClickBehavior: (p.rightClickBehavior === 'copyPaste'
        ? 'copyPaste'
        : 'default') as RightClickBehavior,
    }),
    ...(typeof p.logs === 'boolean' && { logs: p.logs }),
    ...(p.theme && typeof p.theme === 'object' && { theme: { ...DEFAULT_THEME, ...p.theme } }),
  };
}

export function saveConfig(_config: Config): void {
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  const content = JSON.stringify(
    {
      port: DEFAULT_CONFIG.port,
      host: DEFAULT_CONFIG.host,
    },
    null,
    2,
  );
  fs.writeFileSync(getConfigPath(), content, 'utf8');
}
