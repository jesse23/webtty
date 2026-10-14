// The CLI's composition root: parse argv, then dispatch to one command handler with the deps it
// was given. Aliases and usage errors live here; what each command does lives in commands.ts
// (ADR 063).

import { GO_ALIASES, parseArgs } from './cli-args';
import { type CliDeps, createCliDeps } from './cli-deps';
import { helpText } from './help-text';

/**
 * Runs one CLI invocation. With no command it opens the `main` session, like `webtty go`.
 *
 * @param argv - The full `process.argv` (runtime and script path first).
 * @param deps - The process and the command handlers; the real ones by default.
 */
export async function main(
  argv: readonly string[],
  deps: CliDeps = createCliDeps(),
): Promise<void> {
  const { command, rest, baseDir } = parseArgs(argv.slice(2));
  const { commands } = deps;

  if (!command) {
    await commands.go('main', baseDir);
    return;
  }
  if (GO_ALIASES.has(command)) {
    await commands.go(rest[0] ?? 'main', baseDir);
    return;
  }
  switch (command) {
    case 'ls':
    case 'list':
      await commands.list(rest[0]);
      return;
    case 'rm':
    case 'remove':
      await commands.remove(rest[0]);
      return;
    case 'mv':
    case 'move':
    case 'rename':
      await commands.rename(rest[0], rest[1]);
      return;
    case 'stop':
      await commands.stop();
      return;
    case 'start':
      await commands.start();
      return;
    case 'config':
      commands.config();
      return;
    case 'run': {
      const [id, runCmd, ...runArgs] = rest;
      if (!id) {
        deps.err('usage: webtty run <id> [cmd [args...]]');
        deps.exit(1);
        return;
      }
      await commands.run(id, runCmd, runArgs);
      return;
    }
    case 'key':
      commands.key();
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
