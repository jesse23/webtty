// The text `webtty help` prints. A pure util kept apart from the dispatcher so its exact bytes
// are pinned by a test (ADR 063).

const INDENT = '  ';
/** Width of the widest term, "mv <id> <new-id>". */
const TERM_COLUMN = 18;

function row(term: string, desc: string): string {
  return `${INDENT}${term.padEnd(TERM_COLUMN)}  ${desc}`;
}

/** The usage text, one string without a trailing newline (the caller prints it as one line). */
export function helpText(): string {
  return [
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
    row('run <id> [cmd]', 'Start PTY (no browser) or run a command in a session'),
    row('stop', 'Stop the webtty server'),
    row('start', 'Start the webtty server'),
    row('config', 'Open the config file in $VISUAL, $EDITOR, or a default editor'),
    row('key', 'Capture a key combo and print its chars value for keyboardBindings'),
    row('help', 'Show this help message'),
    row('-v, --version', 'Print the webtty version'),
  ].join('\n');
}
