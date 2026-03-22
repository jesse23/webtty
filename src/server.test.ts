import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, 'server.ts');

const PORT = 2399;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error('Server did not start in time');
}

describe('server', () => {
  let proc: ChildProcess;

  beforeAll(async () => {
    proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
    await waitForServer();
  });

  afterAll(() => {
    proc.kill();
  });

  test('GET / returns HTML', async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
  });

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${BASE_URL}/unknown`);
    expect(res.status).toBe(404);
  });

  test('POST /api/server/stop returns 200 and stops server', async () => {
    const res = await fetch(`${BASE_URL}/api/server/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('stopping');

    await Bun.sleep(200);

    await expect(fetch(`${BASE_URL}/`)).rejects.toThrow();
  });
});
