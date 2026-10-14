// Where webtty keeps its configuration on disk. A small util module that reads HOME per
// call, so tests can point it at a temporary directory (ADR 062).
import os from 'node:os';
import path from 'node:path';

/** Returns the webtty config directory: `~/.config/webtty`. */
export function configDir(): string {
  // os.homedir() is the authoritative home directory. process.env.HOME is used
  // as an override in tests (e.g. to isolate config state), but only when it is
  // an absolute path — guarding against accidental env pollution such as the
  // string "undefined" being assigned when HOME was originally unset on Windows.
  const home =
    process.env.HOME && path.isAbsolute(process.env.HOME) ? process.env.HOME : os.homedir();
  return path.join(home, '.config', 'webtty');
}

/** Returns the config file path, `~/.config/webtty/config.json`, which loadConfig reads and initConfig writes. */
export function getConfigPath(): string {
  return path.join(configDir(), 'config.json');
}
