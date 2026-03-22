import { afterAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(__dirname, 'cli.ts');

const PORT = 2398;
const BASE_URL = `http://localhost:${PORT}`;

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    env: { ...process.env, PORT: String(PORT) },
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

async function waitForServer(timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/`);
      return true;
    } catch {
      await Bun.sleep(100);
    }
  }
  return false;
}

describe('cli', () => {
  afterAll(async () => {
    await fetch(`${BASE_URL}/api/server/stop`, { method: 'POST' }).catch(() => {});
  });

  test('unknown command exits with error', async () => {
    const { stderr, exitCode } = await runCli('unknown');
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Usage');
  });

  test('start launches the server', async () => {
    const { stdout, exitCode } = await runCli('start');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('wtty started');
    const running = await waitForServer();
    expect(running).toBe(true);
  });

  test('stop shuts down the server', async () => {
    const { stdout, exitCode } = await runCli('stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('wtty stopped');
    await Bun.sleep(200);
    await expect(fetch(`${BASE_URL}/`)).rejects.toThrow();
  });

  test('stop when not running reports not running', async () => {
    const { stdout, exitCode } = await runCli('stop');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('wtty is not running');
  });
});
