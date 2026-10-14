// Everything the CLI dispatcher reaches outside itself: the output streams, the exit call, the
// version and the command handlers. Types plus a factory over the real globals, so main.ts is
// tested with fakes instead of subprocesses (ADR 063).
// Interim shape: the `commands` table goes away in the commands/ split, when CliDeps becomes
// { client, out, err, exit, spawn, config } and each command takes (args, deps) (ADR 063).
import { getVersion } from '../version';
import {
  cmdConfig,
  cmdGo,
  cmdKey,
  cmdList,
  cmdRemove,
  cmdRename,
  cmdRun,
  cmdStart,
  cmdStop,
} from './commands';

/** The command handlers main() dispatches to, one per command (aliases resolve before the call). */
export interface CliCommands {
  go(id: string, baseDir?: string): Promise<void>;
  list(filter?: string): Promise<void>;
  remove(id?: string): Promise<void>;
  rename(id?: string, newId?: string): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  config(): void;
  run(id: string, cmd: string | undefined, args: string[]): Promise<void>;
  key(): void;
}

/** What main() needs from the process; tests pass recording fakes. */
export interface CliDeps {
  /** Prints one line to stdout (console.log). */
  out(text: string): void;
  /** Prints one line to stderr (console.error). */
  err(text: string): void;
  /** Ends the process with `code`; a fake may return, so callers return right after it. */
  exit(code: number): void;
  /** The package version `webtty -v` prints. */
  version(): string;
  /** The command handlers; temporary until the commands/ split passes deps to each command. */
  commands: CliCommands;
}

/** The production deps: the real console, process.exit and the command functions. */
export function createCliDeps(): CliDeps {
  return {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    exit: (code) => process.exit(code),
    version: getVersion,
    commands: {
      go: cmdGo,
      list: cmdList,
      remove: cmdRemove,
      rename: cmdRename,
      stop: cmdStop,
      start: cmdStart,
      config: cmdConfig,
      run: cmdRun,
      key: cmdKey,
    },
  };
}
