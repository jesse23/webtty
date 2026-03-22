import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

async function waitForServer(baseUrl: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error('Server did not start in time');
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

describe('server', () => {
  let proc: ChildProcess;
  let baseUrl: string;

  beforeAll(async () => {
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    await waitForServer(baseUrl);
  });

  afterAll(() => {
    proc.kill();
  });

  test('GET / returns HTML', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
  });

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  test('POST /api/server/stop returns 200 and stops server', async () => {
    const res = await fetch(`${baseUrl}/api/server/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('stopping');

    await waitForServerDown(baseUrl);

    await expect(fetch(`${baseUrl}/`)).rejects.toThrow();
  });
});
