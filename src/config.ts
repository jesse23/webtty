import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  port: number;
  shell: string;
  scrollbackBuffer: number;
}

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'webtty');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export const DEFAULTS: Config = {
  port: 2346,
  shell:
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash'),
  scrollbackBuffer: 256 * 1024,
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
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`webtty: invalid JSON in config file ${CONFIG_PATH}`);
  }

  const partial = parsed as Partial<Config>;
  return {
    port: typeof partial.port === 'number' ? partial.port : DEFAULTS.port,
    shell: typeof partial.shell === 'string' ? partial.shell : DEFAULTS.shell,
    scrollbackBuffer:
      typeof partial.scrollbackBuffer === 'number'
        ? partial.scrollbackBuffer
        : DEFAULTS.scrollbackBuffer,
  };
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
