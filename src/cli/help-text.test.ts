import { describe, expect, test } from 'bun:test';
import { helpText } from './help-text';

describe('helpText', () => {
  test('is byte-identical to the published usage', () => {
    expect(helpText()).toBe(
      [
        'Launch Terminal UI in the browser.',
        '',
        'USAGE',
        '  webtty              Open main session in the browser',
        '  webtty [command]    Execute a specific command',
        '',
        'COMMANDS',
        '  go [id]             Open a new or existing session in the browser',
        '  ls [id]             List all sessions, or filter by id substring',
        '  rm <id>             Destroy a session',
        '  mv <id> <new-id>    Rename a session',
        '  run <id> [cmd]      Start PTY (no browser) or run a command in a session',
        '  stop                Stop the webtty server',
        '  start               Start the webtty server',
        '  config              Open the config file in $VISUAL, $EDITOR, or a default editor',
        '  key                 Capture a key combo and print its chars value for keyboardBindings',
        '  help                Show this help message',
        '  -v, --version       Print the webtty version',
      ].join('\n'),
    );
  });
});
