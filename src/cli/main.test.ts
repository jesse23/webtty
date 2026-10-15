// Tests for the CLI's composition root: dispatch of every command and alias, usage errors, and
// the production deps createCliDeps wires to the real process (ADR 063).
import { describe, expect, spyOn, test } from 'bun:test';
import path from 'node:path';
import { WebttyClient } from './api-client';
import { createCliDeps } from './cli-deps';
import { helpText } from './help-text';
import { CLI_COMMANDS, type CliCommands, main } from './main';
import { fakeCliDeps } from './test-support/fake-cli-deps';

/** A command table whose entries record `name(args)`, over recording fake deps. */
function fakeCommands() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      // Every command's last argument is the deps; only the parsed args are recorded.
      calls.push([name, ...args.slice(0, -1)]);
    };
  const asyncRecord =
    (name: string) =>
    async (...args: unknown[]) => {
      record(name)(...args);
    };
  const commands: CliCommands = {
    go: asyncRecord('go'),
    list: asyncRecord('list'),
    remove: asyncRecord('remove'),
    rename: asyncRecord('rename'),
    stop: asyncRecord('stop'),
    start: asyncRecord('start'),
    editConfig: record('editConfig'),
    run: asyncRecord('run'),
    key: record('key'),
  };
  return { commands, calls };
}

/** Runs main as `webtty ...args` and returns what it recorded. */
async function run(...args: string[]) {
  const fake = fakeCliDeps();
  const { commands, calls } = fakeCommands();
  await main(['bun', 'webtty', ...args], fake.deps, commands);
  return { ...fake, calls };
}

describe('main dispatch', () => {
  const cases: Array<[string[], Array<[string, ...unknown[]]>]> = [
    [[], [['go', { id: undefined, baseDir: undefined }]]],
    [['go'], [['go', { id: undefined, baseDir: undefined }]]],
    [['go', 'x'], [['go', { id: 'x', baseDir: undefined }]]],
    [['a', 'x'], [['go', { id: 'x', baseDir: undefined }]]],
    [['attach', 'x'], [['go', { id: 'x', baseDir: undefined }]]],
    [['open'], [['go', { id: undefined, baseDir: undefined }]]],
    [['--dir', '/tmp/w'], [['go', { id: undefined, baseDir: path.resolve('/tmp/w') }]]],
    [['go', 'x', '--dir', '/tmp/w'], [['go', { id: 'x', baseDir: path.resolve('/tmp/w') }]]],
    [['ls'], [['list', { filter: undefined }]]],
    [['list', 'ab'], [['list', { filter: 'ab' }]]],
    [['rm', 'x'], [['remove', { id: 'x' }]]],
    [['remove'], [['remove', { id: undefined }]]],
    [['mv', 'a', 'b'], [['rename', { id: 'a', newId: 'b' }]]],
    [['move', 'a'], [['rename', { id: 'a', newId: undefined }]]],
    [['rename', 'a', 'b'], [['rename', { id: 'a', newId: 'b' }]]],
    [['stop'], [['stop']]],
    [['start'], [['start']]],
    [['config'], [['editConfig']]],
    [['run', 'x'], [['run', { id: 'x', cmd: undefined, args: [] }]]],
    [['run', 'x', 'ls', '-la', 'dir'], [['run', { id: 'x', cmd: 'ls', args: ['-la', 'dir'] }]]],
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

describe('CLI_COMMANDS and createCliDeps', () => {
  test('CLI_COMMANDS holds one command per module', async () => {
    const { go } = await import('./commands/go');
    const { key } = await import('./commands/key');
    const { run } = await import('./commands/run');
    expect(CLI_COMMANDS.go).toBe(go);
    expect(CLI_COMMANDS.key).toBe(key);
    expect(CLI_COMMANDS.run).toBe(run);
    expect(Object.keys(CLI_COMMANDS).sort()).toEqual(
      ['editConfig', 'go', 'key', 'list', 'remove', 'rename', 'run', 'start', 'stop'].sort(),
    );
  });

  test('wires the configured client, the config loader and the package version', async () => {
    const deps = createCliDeps();
    const { loadConfig } = await import('../config');
    const { getVersion } = await import('../version');
    expect(deps.client).toBeInstanceOf(WebttyClient);
    expect(deps.config).toBe(loadConfig);
    expect(deps.version).toBe(getVersion);
    expect(deps.editor.env).toBe(process.env);
  });

  test('server.start is startServer, so it runs with its defaults', async () => {
    const { startServer } = await import('./server-process');
    expect(createCliDeps().server.start).toBe(startServer);
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

  test('write goes to process.stdout and process.stderr without a newline', () => {
    const stdout = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deps = createCliDeps();
      deps.write.stdout('out');
      deps.write.stderr('err');
      expect(stdout).toHaveBeenCalledWith('out');
      expect(stderr).toHaveBeenCalledWith('err');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  test('server.stop stops the given client and openBrowser honours WEBTTY_NO_OPEN', async () => {
    const requests: string[] = [];
    const client = new WebttyClient('http://127.0.0.1:1', async (url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response('no', { status: 500 });
    });
    const deps = createCliDeps(client);
    expect(await deps.server.stop()).toBe(false);
    expect(requests).toEqual(['POST http://127.0.0.1:1/api/server/stop']);

    const saved = process.env.WEBTTY_NO_OPEN;
    process.env.WEBTTY_NO_OPEN = '1';
    try {
      expect(() => deps.openBrowser('http://localhost:1/s/x')).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.WEBTTY_NO_OPEN;
      else process.env.WEBTTY_NO_OPEN = saved;
    }
  });
});
