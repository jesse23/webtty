import { describe, expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import { type CliCommands, type CliDeps, createCliDeps } from './cli-deps';
import { helpText } from './help-text';
import { main } from './main';

/** Deps whose commands record `name(args)` and whose streams and exit record into arrays. */
function fakeDeps() {
  const calls: Array<[string, ...unknown[]]> = [];
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const asyncRecord =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const commands: CliCommands = {
    go: asyncRecord('go'),
    list: asyncRecord('list'),
    remove: asyncRecord('remove'),
    rename: asyncRecord('rename'),
    stop: asyncRecord('stop'),
    start: asyncRecord('start'),
    config: record('config'),
    run: asyncRecord('run'),
    key: record('key'),
  };
  const deps: CliDeps = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    exit: (code) => exits.push(code),
    version: () => '9.9.9',
    commands,
  };
  return { deps, calls, out, err, exits };
}

/** Runs main as `webtty ...args` and returns what it recorded. */
async function run(...args: string[]) {
  const fake = fakeDeps();
  await main(['bun', 'webtty', ...args], fake.deps);
  return fake;
}

describe('main dispatch', () => {
  const cases: Array<[string[], Array<[string, ...unknown[]]>]> = [
    [[], [['go', 'main', undefined]]],
    [['go'], [['go', 'main', undefined]]],
    [['go', 'x'], [['go', 'x', undefined]]],
    [['a', 'x'], [['go', 'x', undefined]]],
    [['attach', 'x'], [['go', 'x', undefined]]],
    [['open'], [['go', 'main', undefined]]],
    [['--dir', '/tmp/w'], [['go', 'main', path.resolve('/tmp/w')]]],
    [['go', 'x', '--dir', '/tmp/w'], [['go', 'x', path.resolve('/tmp/w')]]],
    [['ls'], [['list', undefined]]],
    [['list', 'ab'], [['list', 'ab']]],
    [['rm', 'x'], [['remove', 'x']]],
    [['remove'], [['remove', undefined]]],
    [['mv', 'a', 'b'], [['rename', 'a', 'b']]],
    [['move', 'a'], [['rename', 'a', undefined]]],
    [['rename', 'a', 'b'], [['rename', 'a', 'b']]],
    [['stop'], [['stop']]],
    [['start'], [['start']]],
    [['config'], [['config']]],
    [['run', 'x'], [['run', 'x', undefined, []]]],
    [['run', 'x', 'ls', '-la', 'dir'], [['run', 'x', 'ls', ['-la', 'dir']]]],
    [['key'], [['key']]],
  ];
  for (const [args, expected] of cases) {
    test(`webtty ${args.join(' ') || '(no args)'}`, async () => {
      const { calls, out, err, exits } = await run(...args);
      expect(calls).toEqual(expected);
      expect(out).toEqual([]);
      expect(err).toEqual([]);
      expect(exits).toEqual([]);
    });
  }

  for (const flag of ['-v', '--version']) {
    test(`${flag} prints the version`, async () => {
      const { calls, out, exits } = await run(flag);
      expect(out).toEqual(['9.9.9']);
      expect(calls).toEqual([]);
      expect(exits).toEqual([]);
    });
  }

  for (const flag of ['help', '--help', '-h']) {
    test(`${flag} prints the help text`, async () => {
      const { out, exits } = await run(flag);
      expect(out).toEqual([helpText()]);
      expect(exits).toEqual([]);
    });
  }

  test('run without an id prints usage and exits 1', async () => {
    const { calls, err, exits } = await run('run');
    expect(err).toEqual(['usage: webtty run <id> [cmd [args...]]']);
    expect(exits).toEqual([1]);
    expect(calls).toEqual([]);
  });

  test('an unknown command prints a hint and exits 1', async () => {
    const { calls, err, exits } = await run('bogus');
    expect(err).toEqual(["webtty: unknown command 'bogus'\nRun `webtty help` for usage."]);
    expect(exits).toEqual([1]);
    expect(calls).toEqual([]);
  });
});

describe('createCliDeps', () => {
  test('wires every command and the package version', async () => {
    const deps = createCliDeps();
    const { cmdGo, cmdKey, cmdRun } = await import('./commands');
    const { getVersion } = await import('../version');
    expect(deps.commands.go).toBe(cmdGo);
    expect(deps.commands.key).toBe(cmdKey);
    expect(deps.commands.run).toBe(cmdRun);
    expect(Object.keys(deps.commands).sort()).toEqual(
      ['config', 'go', 'key', 'list', 'remove', 'rename', 'run', 'start', 'stop'].sort(),
    );
    expect(deps.version).toBe(getVersion);
  });
});

describe('createCliDeps streams', () => {
  test('out, err and exit go to console.log, console.error and process.exit', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    try {
      const deps = createCliDeps();
      deps.out('to stdout');
      deps.err('to stderr');
      deps.exit(3);
      expect(log).toHaveBeenCalledWith('to stdout');
      expect(error).toHaveBeenCalledWith('to stderr');
      expect(exit).toHaveBeenCalledWith(3);
    } finally {
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });
});
