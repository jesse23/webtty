import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, 'cli.ts');
const SERVER_ENTRY = path.resolve(__dirname, 'server.ts');

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function runCli(
  port: number,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    env: { ...process.env, PORT: String(port), WEBTTY_NO_OPEN: '1' },
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

async function waitForServer(baseUrl: string, timeout = 5000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/sessions`);
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

async function waitForServerDown(baseUrl: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/sessions`);
      await Bun.sleep(100);
    } catch {
      return;
    }
  }
  throw new Error('Server did not shut down in time');
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
    expect(stderr).toContain('error');
  });

  test('start launches the server', async () => {
    const { stdout, exitCode } = await runCli(port, 'start');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('webtty started');
    expect(await waitForServer(baseUrl)).toBe(true);
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
});

describe('cli — session management', () => {
  let port: number;
  let baseUrl: string;
  let serverProc: ChildProcess;

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    await waitForServer(baseUrl);
  });

  afterAll(() => {
    serverProc.kill();
  });

  test('ls prints no sessions on empty server', async () => {
    const { stdout, exitCode } = await runCli(port, 'ls');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no sessions');
  });

  test('run creates a session and prints url', async () => {
    const { stdout, exitCode } = await runCli(port, 'run', 'my-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`/s/my-session`);

    const res = await fetch(`${baseUrl}/api/sessions/my-session`);
    expect(res.status).toBe(200);
  });

  test('run with existing id reuses session without error', async () => {
    const { stdout, exitCode } = await runCli(port, 'run', 'my-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`/s/my-session`);
  });

  test('run without id creates session with auto-generated id', async () => {
    const { stdout, exitCode } = await runCli(port, 'run');
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\/s\/[a-f0-9]{8}/);
  });

  test('ls shows created sessions', async () => {
    const { stdout, exitCode } = await runCli(port, 'ls');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('my-session');
  });

  test('rename renames a session', async () => {
    const { stdout, exitCode } = await runCli(port, 'rename', 'my-session', 'renamed-session');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('renamed');
    expect(stdout).toContain('renamed-session');

    expect((await fetch(`${baseUrl}/api/sessions/my-session`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/sessions/renamed-session`)).status).toBe(200);
  });

  test('rename non-existent session exits with error', async () => {
    const { exitCode, stderr } = await runCli(port, 'rename', 'does-not-exist', 'new-name');
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
