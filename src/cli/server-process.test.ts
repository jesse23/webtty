// Tests for the background server process: the entry it spawns, the production deps, and
// startServer and stopServer over fake spawn, filesystem and client (ADR 063).
import { describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config';
import { cleanupTmpHome, makeTmpHome } from '../test-support/server-harness';
import { type FetchLike, WebttyClient } from './api-client';
import {
  defaultServerProcessDeps,
  logPath,
  resolveServerEntry,
  type ServerProcessDeps,
  startServer,
  stopServer,
} from './server-process';

describe('resolveServerEntry', () => {
  const cases: Array<[string, string, boolean, boolean, string]> = [
    ['src under bun', '/pkg/src/cli', true, false, '/pkg/src/server/index.ts'],
    ['dist under bun', '/pkg/dist/cli', false, false, '/pkg/dist/server/index.js'],
    ['src under node', '/pkg/src/cli', true, true, '/pkg/dist/server/index.js'],
    ['dist under node', '/pkg/dist/cli', false, true, '/pkg/dist/server/index.js'],
  ];
  for (const [name, cliDir, runningFromSrc, useNode, expected] of cases) {
    test(name, () => {
      expect(resolveServerEntry({ cliDir, runningFromSrc, useNode })).toBe(path.resolve(expected));
    });
  }
});

describe('logPath', () => {
  test('returns path inside ~/.config/webtty/', () => {
    expect(logPath()).toBe(path.join(os.homedir(), '.config', 'webtty', 'server.log'));
  });
});

describe('defaultServerProcessDeps', () => {
  test('points at this checkout and the live process', () => {
    const deps = defaultServerProcessDeps();
    expect(deps.entry.runningFromSrc).toBe(true);
    expect(deps.entry.cliDir).toBe(import.meta.dir);
    expect(deps.execPath).toBe(process.execPath);
    expect(deps.env).toBe(process.env);
    expect(deps.useNode).toBe(process.platform === 'win32');
  });

  test('openLog creates the directory and opens the file for appending', async () => {
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-log-'));
    const file = path.join(dir, 'nested', 'server.log');
    const deps = defaultServerProcessDeps();
    const fd = deps.openLog(file);
    fs.writeSync(fd, 'line\n');
    deps.closeFd(fd);
    expect(fs.readFileSync(file, 'utf8')).toBe('line\n');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('err and exit go to console.error and process.exit', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    try {
      const deps = defaultServerProcessDeps();
      deps.err('boom');
      deps.exit(1);
      expect(error).toHaveBeenCalledWith('boom');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  test("isRunning probes the configured port's /api/sessions", async () => {
    const home = makeTmpHome('server-process');
    fs.mkdirSync(path.join(home, '.config', 'webtty'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'webtty', 'config.json'),
      JSON.stringify({ port: 41003 }),
    );
    const savedHome = process.env.HOME;
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        seen.push(String(url));
        return Response.json([]);
      },
      { preconnect: realFetch.preconnect },
    );
    process.env.HOME = home;
    try {
      expect(await defaultServerProcessDeps().isRunning()).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      process.env.HOME = savedHome;
      cleanupTmpHome(home);
    }
    expect(seen).toEqual(['http://127.0.0.1:41003/api/sessions']);
  });

  test('sleep resolves after the delay', async () => {
    const start = Date.now();
    await defaultServerProcessDeps().sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });
});

/** A child process that records unref and, when `spawnError` is set, emits it on 'error'. */
function fakeChild(spawnError?: Error) {
  return {
    unref: mock(() => {}),
    on: mock((event: string, cb: (err: Error) => void) => {
      if (event === 'error' && spawnError) cb(spawnError);
    }),
  };
}

/** Deps that record every call; the server answers on the first probe unless overridden. */
function fakeDeps(overrides: Partial<ServerProcessDeps> = {}) {
  const child = fakeChild();
  const errors: string[] = [];
  const exits: number[] = [];
  const spawn = mock(() => child);
  const deps: ServerProcessDeps = {
    spawn,
    loadConfig: () => ({ ...DEFAULT_CONFIG, port: 4321 }),
    existsSync: () => true,
    openLog: mock(() => 99),
    closeFd: mock(() => {}),
    isRunning: async () => true,
    err: (text) => errors.push(text),
    exit: (code) => exits.push(code),
    sleep: async () => {},
    env: { HOME: '/home/u' },
    execPath: '/usr/bin/bun',
    useNode: false,
    entry: { cliDir: '/pkg/src/cli', runningFromSrc: true },
    ...overrides,
  };
  return { deps, spawn, child, errors, exits };
}

describe('startServer', () => {
  test('spawns the executor on the entry, detached with PORT, and returns once reachable', async () => {
    let probes = 0;
    const { deps, spawn, child, exits } = fakeDeps({ isRunning: async () => ++probes >= 3 });
    await startServer(10000, deps);

    expect(spawn).toHaveBeenCalledWith('/usr/bin/bun', [path.resolve('/pkg/src/server/index.ts')], {
      detached: true,
      stdio: 'ignore',
      env: { HOME: '/home/u', PORT: '4321' },
    });
    expect(child.unref).toHaveBeenCalled();
    expect(probes).toBe(3);
    expect(exits).toEqual([]);
  });

  test('passes the log fd to stdio and closes it when logs is on', async () => {
    const { deps, spawn } = fakeDeps({ loadConfig: () => ({ ...DEFAULT_CONFIG, logs: true }) });
    await startServer(10000, deps);

    const options = (spawn.mock.calls[0] as unknown[])[2] as { stdio: unknown };
    expect(options.stdio).toEqual(['ignore', 99, 99]);
    expect(deps.openLog).toHaveBeenCalledWith(logPath());
    expect(deps.closeFd).toHaveBeenCalledWith(99);
  });

  test('uses node on the built entry when useNode', async () => {
    const { deps, spawn } = fakeDeps({ useNode: true });
    await startServer(10000, deps);
    const [exec, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(exec).toBe('node');
    expect(args).toEqual([path.resolve('/pkg/dist/server/index.js')]);
  });

  test('exits 1 without spawning when the entry is missing', async () => {
    const { deps, spawn, errors, exits } = fakeDeps({ existsSync: () => false });
    await startServer(10000, deps);
    expect(errors).toEqual([
      `webtty: server entry not found at ${path.resolve('/pkg/src/server/index.ts')}`,
    ]);
    expect(exits).toEqual([1]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('reports a spawn error without the Windows hint', async () => {
    const child = fakeChild(new Error('spawn ENOENT'));
    const { deps, errors, exits } = fakeDeps({
      spawn: () => child,
    });
    await startServer(10000, deps);
    expect(errors).toEqual(['webtty: failed to start server: spawn ENOENT']);
    expect(exits).toEqual([1]);
  });

  test('reports a spawn error with the Windows hint when useNode', async () => {
    const child = fakeChild(new Error('spawn ENOENT'));
    const { deps, errors } = fakeDeps({
      useNode: true,
      spawn: () => child,
    });
    await startServer(10000, deps);
    expect(errors).toEqual([
      'webtty: failed to start server: spawn ENOENT (Node.js must be on PATH when running webtty under Bun on Windows)',
    ]);
  });

  test('exits 1 when the server never answers before the timeout', async () => {
    const sleep = mock(() => new Promise<void>((r) => setTimeout(r, 5)));
    const { deps, errors, exits } = fakeDeps({ isRunning: async () => false, sleep });
    await startServer(30, deps);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(errors).toEqual(['webtty: server did not start in time']);
    expect(exits).toEqual([1]);
  });
});

describe('stopServer', () => {
  const client = (fetchFn: FetchLike) => new WebttyClient('http://127.0.0.1:1', fetchFn);

  test('returns true when server stops after POST succeeds', async () => {
    let probes = 0;
    const calls: string[] = [];
    const stopped = client(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (init?.method === 'POST') return new Response('stopping', { status: 200 });
      if (++probes >= 2) throw new Error('connection refused');
      return new Response('[]', { status: 200 });
    });

    expect(await stopServer(stopped)).toBe(true);
    expect(calls).toEqual([
      'POST http://127.0.0.1:1/api/server/stop',
      'GET http://127.0.0.1:1/api/sessions',
      'GET http://127.0.0.1:1/api/sessions',
    ]);
  });

  test('returns false when POST to stop endpoint fails', async () => {
    const refused = client(async (_url, init) =>
      init?.method === 'POST'
        ? new Response('error', { status: 500 })
        : new Response('[]', { status: 200 }),
    );
    expect(await stopServer(refused)).toBe(false);
  });

  test('returns false when fetch throws', async () => {
    const down = client(async () => {
      throw new Error('connection refused');
    });
    expect(await stopServer(down)).toBe(false);
  });

  test('returns false when server does not come down within timeout', async () => {
    const stuck = client(async () => new Response('[]', { status: 200 }));
    expect(await stopServer(stuck, 100)).toBe(false);
  });
});
