import { Command, type Help } from 'commander';
import { registerCommands } from './commands';

const BOLD = '\x1b[1m';
const YELLOW = '\x1b[1;33m';
const RESET = '\x1b[0m';

const WEBTTY = `${BOLD}${YELLOW}Web TTY${RESET}`;

const CMDS_WITH_ARGS = new Set(['run', 'rm', 'ls', 'rename']);
const CMD_NAME_WIDTH = 'rename'.length;

const program = new Command();
program
  .name('webtty')
  .description(`${WEBTTY} — Terminal UI in the browser`)
  .helpOption(false)
  .configureHelp({
    subcommandTerm(cmd: Command): string {
      const args = cmd.registeredArguments
        .map((arg) => (arg.required ? `<${arg.name()}>` : `[${arg.name()}]`))
        .join(' ');
      const name = CMDS_WITH_ARGS.has(cmd.name()) ? cmd.name().padEnd(CMD_NAME_WIDTH) : cmd.name();
      return args ? `${name} ${args}` : name;
    },
    formatHelp(cmd: Command, helper: Help): string {
      const helpWidth = helper.helpWidth ?? 80;
      const termWidth = helper.padWidth(cmd, helper);

      const callFormatItem = (term: string, description: string) =>
        helper.formatItem(term, termWidth, description, helper);

      const description = helper.commandDescription(cmd);
      const descriptionBlock =
        description.length > 0
          ? [helper.boxWrap(helper.styleCommandDescription(description), helpWidth), '']
          : [];

      const usageBlock = [
        `${helper.styleTitle('Usage:')} ${helper.styleUsage(helper.commandUsage(cmd))}`,
        '',
      ];

      const commandGroups = (
        helper as unknown as {
          groupItems: (
            a: Command[],
            b: Command[],
            c: (s: Command) => string,
          ) => Map<string, Command[]>;
        }
      ).groupItems(
        cmd.commands,
        helper.visibleCommands(cmd),
        (sub: Command) =>
          (sub as unknown as { helpGroup: () => string }).helpGroup?.() || 'Commands:',
      );
      const commandsBlock: string[] = [];
      commandGroups.forEach((commands: Command[], group: string) => {
        const commandList = commands.map((sub: Command) =>
          callFormatItem(
            helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
            helper.styleSubcommandDescription(helper.subcommandDescription(sub)),
          ),
        );
        commandsBlock.push(
          ...(
            helper as unknown as { formatItemList: (h: string, i: string[], hp: Help) => string[] }
          ).formatItemList(group, commandList, helper),
        );
      });

      return [...descriptionBlock, ...usageBlock, ...commandsBlock].join('\n');
    },
  });

registerCommands(program);

program.action(async () => {
  await program.parseAsync(['run', 'main'], { from: 'user' });
});

program.parseAsync(process.argv);
