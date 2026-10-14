// `webtty config`: open `~/.config/webtty/config.json` in the user's editor, creating it first.
// A command over an injected EditorHost (filesystem, environment, child process) (ADR 063).
import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../../config';
import type { CliDeps } from '../cli-deps';

/** The filesystem, environment and process `webtty config` touches. */
export interface EditorHost {
  /** The config directory, `~/.config/webtty`. */
  configDir(): string;
  /** Creates `dir` and its parents if missing. */
  mkdirp(dir: string): void;
  exists(file: string): boolean;
  writeFile(file: string, text: string): void;
  /** Read for `$VISUAL` and `$EDITOR` when the command runs. */
  env: NodeJS.ProcessEnv;
  platform: string;
  /** Runs `command args` on this terminal and waits for it to exit. */
  runAttached(command: string, args: string[]): void;
}

/** The live filesystem, environment and `child_process.spawnSync`. */
export function processEditorHost(): EditorHost {
  return {
    configDir,
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
    exists: (file) => fs.existsSync(file),
    writeFile: (file, text) => fs.writeFileSync(file, text, 'utf8'),
    env: process.env,
    platform: process.platform,
    runAttached: (command, args) => {
      childProcess.spawnSync(command, args, { stdio: 'inherit' });
    },
  };
}

/** Opens the config file in `$VISUAL`, else `$EDITOR`, else notepad (Windows) or vi. */
export function editConfig({ editor }: Pick<CliDeps, 'editor'>): void {
  const dir = editor.configDir();
  const configPath = path.join(dir, 'config.json');
  editor.mkdirp(dir);
  if (!editor.exists(configPath)) {
    editor.writeFile(configPath, '{}\n');
  }
  const command =
    editor.env.VISUAL ?? editor.env.EDITOR ?? (editor.platform === 'win32' ? 'notepad' : 'vi');
  editor.runAttached(command, [configPath]);
}
