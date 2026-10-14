// The config service used by the server and the CLI: read the config file (writing a stub on
// first run) and re-export the schema, defaults and parsers, so every '../config' import keeps
// working. A service module; the pure parts live beside it (ADR 062, ADR 009).
import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath } from './config-paths';
import type { Config } from './config-schema';
import { DEFAULT_CONFIG } from './defaults';
import { parseConfig } from './parse-config';

export { toClientConfig } from './client-view';
export { configDir, getConfigPath } from './config-paths';
export {
  CLIENT_CONFIG_KEYS,
  type ClientConfig,
  type ClientConfigKey,
  type Config,
  type KeyboardBinding,
  type RightClickBehavior,
  type Theme,
} from './config-schema';
export { DEFAULT_CONFIG, DEFAULT_KEYBOARD_BINDINGS, DEFAULT_THEME } from './defaults';
export { mergeKeyboardBindings } from './keyboard-bindings';
export { parseConfig, parseRightClickBehavior } from './parse-config';

/**
 * Load config from `~/.config/webtty/config.json`, merged over `DEFAULT_CONFIG`.
 *
 * On first run (file absent), writes the default port/host stub and returns defaults.
 * Unknown keys and keys with wrong types are silently ignored.
 * Throws if the file exists but cannot be read or contains invalid JSON.
 *
 * @returns The resolved {@link Config}, with all missing keys filled from {@link DEFAULT_CONFIG}.
 */
export function loadConfig(): Config {
  if (!fs.existsSync(getConfigPath())) {
    try {
      initConfig();
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

  return parseConfig(parsed);
}

/**
 * Write the initial config stub (`port` + `host` only) to `~/.config/webtty/config.json`.
 *
 * Only writes the two keys that are safe to persist as defaults; all other
 * keys are intentionally omitted so future webtty versions can add new fields
 * without the stub going stale.
 */
export function initConfig(): void {
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
