import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupTmpHome,
  getFreePort,
  makeTmpHome,
  waitForServerDown,
  waitForServerReady,
} from '../utils.test';

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

  test('go without id creates session with auto-generated id', async () => {
    const { stdout, exitCode } = await runCli(port, 'go');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\/s\/[a-f0-9]{8}/);
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
