import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, 'cli.ts');

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
    env: { ...process.env, PORT: String(port) },
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

async function waitForServer(baseUrl: string, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/`);
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
      await fetch(`${baseUrl}/`);
      await Bun.sleep(100);
    } catch {
      return;
    }
  }
  throw new Error('Server did not shut down in time');
}

describe('cli', () => {
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
    expect(stderr).toContain('Usage');
  });

  test('start launches the server', async () => {
    const { stdout, exitCode } = await runCli(port, 'start');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('wtty started');
    const running = await waitForServer(baseUrl);
    expect(running).toBe(true);
  });

  test('stop shuts down the server', async () => {
    const { stdout, exitCode } = await runCli(port, 'stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('wtty stopped');
    await waitForServerDown(baseUrl);
    await expect(fetch(`${baseUrl}/`)).rejects.toThrow();
  });

  test('stop when not running reports not running', async () => {
    const { stdout, exitCode } = await runCli(port, 'stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('wtty is not running');
  });
});
