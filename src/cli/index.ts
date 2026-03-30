import {
  cmdConfig,
  cmdGo,
  cmdKey,
  cmdList,
  cmdRemove,
  cmdRename,
  cmdStart,
  cmdStop,
} from './commands';

const GO_ALIASES = new Set(['go', 'a', 'run', 'attach', 'open']);

function printHelp(): void {
  const indent = '  ';
  const col = 18; // width of the widest term: "mv <id> <new-id>"
  const row = (term: string, desc: string) => `${indent}${term.padEnd(col)}  ${desc}`;

  console.log(
    [
      'Launch Terminal UI in the browser.',
      '',
      'USAGE',
      row('webtty', 'Open main session in the browser'),
      row('webtty [command]', 'Execute a specific command'),
      '',
      'COMMANDS',
      row('go [id]', 'Open a new or existing session in the browser'),
      row('ls [id]', 'List all sessions, or filter by id substring'),
      row('rm <id>', 'Destroy a session'),
      row('mv <id> <new-id>', 'Rename a session'),
      row('stop', 'Stop the webtty server'),
      row('start', 'Start the webtty server'),
      row('config', 'Open the config file in $VISUAL, $EDITOR, or a default editor'),
      row('key', 'Capture a key combo and print its chars value for keyboardBindings'),
      row('help', 'Show this help message'),
    ].join('\n'),
  );
}

const [, , cmd, ...rest] = process.argv;

if (!cmd) {
  await cmdGo();
} else if (GO_ALIASES.has(cmd)) {
  await cmdGo(rest[0]);
} else {
  switch (cmd) {
    case 'ls':
    case 'list':
      await cmdList(rest[0]);
      break;
    case 'rm':
    case 'remove':
      await cmdRemove(rest[0]);
      break;
    case 'mv':
    case 'move':
    case 'rename':
      await cmdRename(rest[0], rest[1]);
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'start':
      await cmdStart();
      break;
    case 'config':
      cmdConfig();
      break;
    case 'key':
      cmdKey();
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`webtty: unknown command '${cmd}'\nRun \`webtty help\` for usage.`);
      process.exit(1);
  }
}
