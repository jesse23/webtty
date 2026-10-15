// Parsing the CLI's argv into a command, its arguments and the `--dir` base directory. A pure
// util: no I/O beyond resolving the directory against the working directory (ADR 063).
import path from 'node:path';

/** The commands that open a session in the browser; with no command at all, `go main` runs. */
export const GO_ALIASES: ReadonlySet<string> = new Set(['go', 'a', 'attach', 'open']);

/** A parsed command line. */
export interface CliArgs {
  /** The first argument left after `--dir` is removed, or undefined for a bare `webtty`. */
  command: string | undefined;
  /** The arguments after the command. */
  rest: string[];
  /** The absolute `--dir` value, the working directory for a new session's shell. */
  baseDir: string | undefined;
}

/**
 * Splits the user's arguments (argv without the runtime and script) into a {@link CliArgs}.
 * `--dir <path>` may sit anywhere; it and its value are removed before the command is read.
 * A trailing `--dir` with no value means the current directory.
 *
 * @param args - `process.argv.slice(2)`.
 */
export function parseArgs(args: readonly string[]): CliArgs {
  const remaining = [...args];
  const dirFlagIdx = remaining.indexOf('--dir');
  let baseDir: string | undefined;
  if (dirFlagIdx !== -1) {
    baseDir = path.resolve(remaining[dirFlagIdx + 1] ?? '.');
    remaining.splice(dirFlagIdx, 2);
  }
  const [command, ...rest] = remaining;
  return { command, rest, baseDir };
}
