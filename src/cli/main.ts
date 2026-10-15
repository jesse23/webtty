// The CLI's composition root: parse argv, then dispatch to one command with the deps it was
// given. Aliases and usage errors live here; what each command does lives in commands/
// (ADR 063).

import { GO_ALIASES, parseArgs } from './cli-args';
import { type CliDeps, createCliDeps } from './cli-deps';
import { editConfig } from './commands/edit-config';
import { go } from './commands/go';
import { key } from './commands/key';
import { list } from './commands/list';
import { remove } from './commands/remove';
import { rename } from './commands/rename';
import { run } from './commands/run';
import { start, stop } from './commands/start-stop';
import { helpText } from './help-text';

/** The commands main() dispatches to (aliases resolve before the call); tests pass recorders. */
export interface CliCommands {
  go: typeof go;
  list: typeof list;
  remove: typeof remove;
  rename: typeof rename;
  start: typeof start;
  stop: typeof stop;
  editConfig: typeof editConfig;
  run: typeof run;
  key: typeof key;
}

/** The real commands, one module each under commands/. */
export const CLI_COMMANDS: CliCommands = {
  go,
  list,
  remove,
  rename,
  start,
  stop,
  editConfig,
  run,
  key,
};

/**
 * Runs one CLI invocation. With no command it opens the `main` session, like `webtty go`.
 *
 * @param argv - The full `process.argv` (runtime and script path first).
 * @param deps - The process, the API client and the server control; the real ones by default.
 * @param commands - The command implementations; the real ones by default.
 */
export async function main(
  argv: readonly string[],
  deps: CliDeps = createCliDeps(),
  commands: CliCommands = CLI_COMMANDS,
): Promise<void> {
  const { command, rest, baseDir } = parseArgs(argv.slice(2));

  if (!command || GO_ALIASES.has(command)) {
    await commands.go({ id: rest[0], baseDir }, deps);
    return;
  }
  switch (command) {
    case 'ls':
    case 'list':
      await commands.list({ filter: rest[0] }, deps);
      return;
    case 'rm':
    case 'remove':
      await commands.remove({ id: rest[0] }, deps);
      return;
    case 'mv':
    case 'move':
    case 'rename':
      await commands.rename({ id: rest[0], newId: rest[1] }, deps);
      return;
    case 'stop':
      await commands.stop(deps);
      return;
    case 'start':
      await commands.start(deps);
      return;
    case 'config':
      commands.editConfig(deps);
      return;
    case 'run': {
      const [id, cmd, ...args] = rest;
      if (!id) {
        deps.err('usage: webtty run <id> [cmd [args...]]');
        deps.exit(1);
        return;
      }
      await commands.run({ id, cmd, args }, deps);
      return;
    }
    case 'key':
      commands.key(deps);
      return;
    case '-v':
    case '--version':
      deps.out(deps.version());
      return;
    case 'help':
    case '--help':
    case '-h':
      deps.out(helpText());
      return;
    default:
      deps.err(`webtty: unknown command '${command}'\nRun \`webtty help\` for usage.`);
      deps.exit(1);
  }
}
