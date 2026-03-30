import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcessModule from 'node:child_process';
import { type ChildProcess, spawn } from 'node:child_process';
import * as fsModule from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupTmpHome,
  getFreePort,
  makeTmpHome,
  waitForServerDown,
  waitForServerReady,
} from '../utils.test';
import { bytesToChars, bytesToDisplay } from './commands';
import * as httpModule from './http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, 'index.ts');
const SERVER_ENTRY = path.resolve(__dirname, '../server/index.ts');

const tmpHome = makeTmpHome('cli-test');

afterAll(() => {
  cleanupTmpHome(tmpHome);
});

async function runCli(
  port: number,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    env: { ...process.env, PORT: String(port), WEBTTY_NO_OPEN: '1', HOME: tmpHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe('cli — lifecycle', () => {
  let port: number;
  let baseUrl: string;

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await fetch(`${baseUrl}/api/server/stop`, { method: 'POST' }).catch(() => {});
  });

  test('unknown command exits with error', async () => {
    const { stderr, exitCode } = await runCli(port, 'unknown');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown command');
  });

  test('start launches the server', async () => {
    const { stdout, exitCode } = await runCli(port, 'start');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('webtty started');
    expect(await waitForServerReady(baseUrl)).toBe(true);
  });

  test('start when already running reports already running', async () => {
    const { stdout, exitCode } = await runCli(port, 'start');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('webtty is already running');
  });

  test('stop shuts down the server', async () => {
    const { stdout, exitCode } = await runCli(port, 'stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('webtty stopped');
    await waitForServerDown(baseUrl);
    await expect(fetch(`${baseUrl}/api/sessions`)).rejects.toThrow();
  });

  test('stop when not running reports not running', async () => {
    const { stdout, exitCode } = await runCli(port, 'stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('webtty is not running');
  });

  test('start launches server after stop', async () => {
    const { stdout, exitCode } = await runCli(port, 'start');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('webtty started');
    expect(await waitForServerReady(baseUrl)).toBe(true);
  });
});

describe('cli — session management', () => {
  let port: number;
  let baseUrl: string;
  let serverProc: ChildProcess;

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(port), HOME: tmpHome },
      stdio: 'ignore',
    });
    await waitForServerReady(baseUrl);
  });

  afterAll(() => {
    serverProc.kill();
  });

  test('ls prints no sessions on empty server', async () => {
    const { stdout, exitCode } = await runCli(port, 'ls');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no sessions');
  });

  test('go creates a session and prints url', async () => {
    const { stdout, exitCode } = await runCli(port, 'go', 'my-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`/s/my-session`);

    const res = await fetch(`${baseUrl}/api/sessions/my-session`);
    expect(res.status).toBe(200);
  });

  test('go with existing id reuses session without error', async () => {
    const { stdout, exitCode } = await runCli(port, 'go', 'my-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`/s/my-session`);
  });

  test('go without id opens main session', async () => {
    const { stdout, exitCode } = await runCli(port, 'go');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('/s/main');
  });

  test('ls shows created sessions', async () => {
    const { stdout, exitCode } = await runCli(port, 'ls');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('my-session');
  });

  test('rename renames a session', async () => {
    const { stdout, exitCode } = await runCli(port, 'mv', 'my-session', 'renamed-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('renamed');
    expect(stdout).toContain('renamed-session');

    expect((await fetch(`${baseUrl}/api/sessions/my-session`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/sessions/renamed-session`)).status).toBe(200);
  });

  test('rename non-existent session exits with error', async () => {
    const { exitCode, stderr } = await runCli(port, 'mv', 'does-not-exist', 'new-name');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  test('rm removes a session', async () => {
    const { stdout, exitCode } = await runCli(port, 'rm', 'renamed-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('removed renamed-session');
    expect((await fetch(`${baseUrl}/api/sessions/renamed-session`)).status).toBe(404);
  });

  test('rm non-existent session exits with error', async () => {
    const { exitCode, stderr } = await runCli(port, 'rm', 'does-not-exist');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('not found');
  });

  test('ls when server not running exits with error', async () => {
    const { stdout, exitCode } = await runCli(port + 1, 'ls');
    expect(exitCode).toBe(1);
    expect(stdout).toContain('not running');
  });
});

describe('bytesToDisplay', () => {
  test('ESC CR → legacy shift+enter', () => {
    expect(bytesToDisplay(Buffer.from([0x1b, 0x0d]))).toBe('ESC CR');
  });

  test('ESC [ 1 3 ; 2 u → KKP shift+enter', () => {
    expect(bytesToDisplay(Buffer.from([0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75]))).toBe(
      'ESC [ 1 3 ; 2 u',
    );
  });

  test('tab → TAB', () => {
    expect(bytesToDisplay(Buffer.from([0x09]))).toBe('TAB');
  });

  test('space → SPC', () => {
    expect(bytesToDisplay(Buffer.from([0x20]))).toBe('SPC');
  });

  test('del → DEL', () => {
    expect(bytesToDisplay(Buffer.from([0x7f]))).toBe('DEL');
  });

  test('unknown control byte → \\xHH', () => {
    expect(bytesToDisplay(Buffer.from([0x00]))).toBe('\\x00');
  });
});

describe('bytesToChars', () => {
  test('ESC CR → legacy shift+enter encoding', () => {
    expect(bytesToChars(Buffer.from([0x1b, 0x0d]))).toBe('"\\u001b\\r"');
  });

  test('ESC [ 1 3 ; 2 u → KKP shift+enter', () => {
    expect(bytesToChars(Buffer.from([0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75]))).toBe(
      '"\\u001b[13;2u"',
    );
  });

  test('printable ASCII passes through', () => {
    expect(bytesToChars(Buffer.from('hello'))).toBe('"hello"');
  });

  test('tab → \\t', () => {
    expect(bytesToChars(Buffer.from([0x09]))).toBe('"\\t"');
  });

  test('non-ASCII control byte → \\uXXXX', () => {
    expect(bytesToChars(Buffer.from([0x00]))).toBe('"\\u0000"');
  });
});

describe('cli — no-arg, help, config', () => {
  let port: number;
  let baseUrl: string;
  let serverProc: ChildProcess;

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(port), HOME: tmpHome },
      stdio: 'ignore',
    });
    await waitForServerReady(baseUrl);
  });

  afterAll(() => {
    serverProc.kill();
  });

  test('no-arg creates main session and prints url', async () => {
    const { stdout, exitCode } = await runCli(port);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('/s/main');
  });

  test('no-arg reuses main session without error', async () => {
    const { stdout, exitCode } = await runCli(port);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('/s/main');
  });

  test('key exits with error when not a TTY', async () => {
    const { stderr, exitCode } = await runCli(port, 'key');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('requires an interactive terminal');
  });

  test('help prints usage', async () => {
    const { stdout, exitCode } = await runCli(port, 'help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('webtty');
  });

  test('config opens config path in $VISUAL', async () => {
    const expectedPath = path.join(tmpHome, '.config', 'webtty', 'config.json');
    const env: Record<string, string> = {
      ...process.env,
      PORT: String(port),
      HOME: tmpHome,
      VISUAL: 'echo',
    };
    delete env.EDITOR;
    const proc = Bun.spawn([process.execPath, CLI_ENTRY, 'config'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toContain(expectedPath);
  });
});

describe('cli — unit (mocked http)', () => {
  let cmds: typeof import('./commands');
  let origFetch: typeof fetch;

  beforeAll(async () => {
    origFetch = global.fetch;
    cmds = await import('./commands');
  });

  afterAll(() => {
    global.fetch = origFetch;
  });

test('cmdStop when running stops server', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(true);
  const stop = spyOn(httpModule, 'stopServer').mockResolvedValueOnce(true);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdStop();
  expect(log).toHaveBeenCalledWith('webtty stopped');
  isRunning.mockRestore();
  stop.mockRestore();
  log.mockRestore();
});

test('cmdStop when stop fails exits with error', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(true);
  const stop = spyOn(httpModule, 'stopServer').mockResolvedValueOnce(false);
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdStop()).rejects.toThrow('exit');
  expect(err).toHaveBeenCalledWith('webtty stop failed');
  isRunning.mockRestore();
  stop.mockRestore();
  err.mockRestore();
  exit.mockRestore();
});

test('cmdStop when not running logs not running', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(false);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdStop();
  expect(log).toHaveBeenCalledWith('webtty is not running');
  isRunning.mockRestore();
  log.mockRestore();
});

test('cmdStart when not running starts server', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(false);
  const start = spyOn(httpModule, 'startServer').mockResolvedValueOnce(undefined);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdStart();
  expect(start).toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('webtty started');
  isRunning.mockRestore();
  start.mockRestore();
  log.mockRestore();
});

test('cmdStart when already running logs already running', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(true);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdStart();
  expect(log).toHaveBeenCalledWith('webtty is already running');
  isRunning.mockRestore();
  log.mockRestore();
});

test('cmdList when not running exits with error', async () => {
  global.fetch = mock(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdList()).rejects.toThrow('exit');
  expect(log).toHaveBeenCalledWith('webtty is not running');
  log.mockRestore();
  exit.mockRestore();
});

test('cmdList with sessions prints table', async () => {
  const sessions = [{ id: 'main', connected: true, createdAt: 1700000000000 }];
  global.fetch = mock(
    async () => new Response(JSON.stringify(sessions)),
  ) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdList();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('main'));
  log.mockRestore();
});

test('cmdList with no sessions prints no sessions', async () => {
  global.fetch = mock(async () => new Response(JSON.stringify([]))) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdList();
  expect(log).toHaveBeenCalledWith('no sessions');
  log.mockRestore();
});

test('cmdRemove without id exits with error', async () => {
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRemove()).rejects.toThrow('exit');
  expect(err).toHaveBeenCalledWith(expect.stringContaining('requires a session id'));
  err.mockRestore();
  exit.mockRestore();
});

test('cmdRemove with valid id removes session', async () => {
  global.fetch = mock(
    async () =>
      new Response(null, {
        status: 204,
        headers: { 'x-sessions-remaining': '1' },
      }),
  ) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdRemove('my-session');
  expect(log).toHaveBeenCalledWith('removed my-session');
  log.mockRestore();
});

test('cmdRemove last session also stops server', async () => {
  global.fetch = mock(
    async () =>
      new Response(null, {
        status: 204,
        headers: { 'x-sessions-remaining': '0' },
      }),
  ) as unknown as typeof fetch;
  const stop = spyOn(httpModule, 'stopServer').mockResolvedValueOnce(true);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdRemove('last');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('webtty stopped'));
  stop.mockRestore();
  log.mockRestore();
});

test('cmdRemove non-existent session exits with error', async () => {
  global.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRemove('ghost')).rejects.toThrow('exit');
  expect(err).toHaveBeenCalledWith(expect.stringContaining('not found'));
  err.mockRestore();
  exit.mockRestore();
});

test('cmdRemove fetch failure exits with error', async () => {
  global.fetch = mock(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRemove('bad')).rejects.toThrow('exit');
  err.mockRestore();
  exit.mockRestore();
});

test('cmdRename without args exits with error', async () => {
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRename()).rejects.toThrow('exit');
  expect(err).toHaveBeenCalledWith(expect.stringContaining('requires two arguments'));
  err.mockRestore();
  exit.mockRestore();
});

test('cmdRename success logs renamed', async () => {
  global.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdRename('old', 'new');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('old'));
  log.mockRestore();
});

test('cmdRename not found exits with error', async () => {
  global.fetch = mock(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRename('x', 'y')).rejects.toThrow('exit');
  expect(err).toHaveBeenCalledWith(expect.stringContaining('not found'));
  err.mockRestore();
  exit.mockRestore();
});

test('cmdRename fetch error exits with error', async () => {
  global.fetch = mock(
    async () => new Response(JSON.stringify({ error: 'conflict' }), { status: 409 }),
  ) as unknown as typeof fetch;
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRename('x', 'y')).rejects.toThrow('exit');
  err.mockRestore();
  exit.mockRestore();
});

test('cmdGo when server not running starts it', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(false);
  const start = spyOn(httpModule, 'startServer').mockResolvedValueOnce(undefined);
  global.fetch = mock(async (url: string) => {
    if (url.includes('/api/sessions/main')) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ id: 'main' }), { status: 200 });
  }) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdGo('main');
  expect(start).toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('/s/main'));
  isRunning.mockRestore();
  start.mockRestore();
  log.mockRestore();
});

test('cmdGo when session exists opens it', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(true);
  global.fetch = mock(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdGo('main');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('/s/main'));
  isRunning.mockRestore();
  log.mockRestore();
});

test('cmdGo session creation failure exits with error', async () => {
  const isRunning = spyOn(httpModule, 'isServerRunning').mockResolvedValueOnce(true);
  global.fetch = mock(async (url: string) => {
    if (url.includes('/api/sessions/fail')) return new Response(null, { status: 404 });
    return new Response(JSON.stringify({ error: 'bad' }), { status: 500 });
  }) as unknown as typeof fetch;
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdGo('fail')).rejects.toThrow('exit');
  isRunning.mockRestore();
  err.mockRestore();
  exit.mockRestore();
});

test('cmdList when not running (fetch throws) exits', async () => {
  global.fetch = mock(async () => {
    throw new Error('conn');
  }) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdList(undefined)).rejects.toThrow('exit');
  log.mockRestore();
  exit.mockRestore();
});

test('cmdList with filter shows matching sessions', async () => {
  const sessions = [
    { id: 'main', connected: true, createdAt: 1700000000000 },
    { id: 'other', connected: false, createdAt: 1700000000000 },
  ];
  global.fetch = mock(
    async () => new Response(JSON.stringify(sessions)),
  ) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  await cmds.cmdList('main');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('main'));
  log.mockRestore();
});

test('cmdRemove when not running exits with error', async () => {
  global.fetch = mock(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRemove('any')).rejects.toThrow('exit');
  expect(log).toHaveBeenCalledWith('webtty is not running');
  log.mockRestore();
  exit.mockRestore();
});

test('cmdRename when not running exits with error', async () => {
  global.fetch = mock(async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  await expect(cmds.cmdRename('x', 'y')).rejects.toThrow('exit');
  expect(log).toHaveBeenCalledWith('webtty is not running');
  log.mockRestore();
  exit.mockRestore();
});

test('cmdConfig opens editor (file exists)', () => {
  const mkdirSpy = spyOn(fsModule, 'mkdirSync').mockImplementation(() => undefined);
  const existsSpy = spyOn(fsModule, 'existsSync').mockReturnValue(true);
  const spawnSpy = spyOn(childProcessModule, 'spawnSync').mockReturnValue(
    {} as ReturnType<typeof childProcessModule.spawnSync>,
  );
  cmds.cmdConfig();
  expect(spawnSpy).toHaveBeenCalled();
  mkdirSpy.mockRestore();
  existsSpy.mockRestore();
  spawnSpy.mockRestore();
});

test('cmdConfig creates file when absent', () => {
  const origHome = process.env.HOME;
  process.env.HOME = `/tmp/webtty-cfg-absent-${Date.now()}`;
  const mkdirSpy = spyOn(fsModule, 'mkdirSync').mockImplementation(() => undefined);
  const spawnSpy = spyOn(childProcessModule, 'spawnSync').mockReturnValue(
    {} as ReturnType<typeof childProcessModule.spawnSync>,
  );
  cmds.cmdConfig();
  process.env.HOME = origHome;
  mkdirSpy.mockRestore();
  spawnSpy.mockRestore();
});

test('cmdKey exits with error when not a TTY', async () => {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  (process.stdin as NodeJS.ReadStream & { setRawMode: unknown }).setRawMode = mock(
    () => process.stdin,
  );
  const resume = spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  const onSpy = spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  cmds.cmdKey();
  expect(err).toHaveBeenCalledWith('webtty key: requires an interactive terminal');
  expect(exit).toHaveBeenCalledWith(1);

  const dataHandler = (
    onSpy as unknown as { mock: { calls: Array<[string, (c: Buffer) => void]> } }
  ).mock.calls.find((c) => c[0] === 'data')?.[1];

  dataHandler?.(Buffer.from([0x61]));
  await new Promise((r) => setTimeout(r, 60));
  dataHandler?.(Buffer.from([0x71]));

  (process.stdin as unknown as Record<string, unknown>).setRawMode = undefined;
  Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
  err.mockRestore();
  exit.mockRestore();
  resume.mockRestore();
  onSpy.mockRestore();
  log.mockRestore();
});
});
