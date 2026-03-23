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

async function waitForServer(baseUrl: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/api/sessions`);
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
      await fetch(`${baseUrl}/api/sessions`);
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

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  test('GET / redirects to /s/main when no sessions exist', async () => {
    const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/s/main');
  });

  test('GET / creates main session when no sessions exist', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/main`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('main');
  });

  test('GET /s/:id returns HTML with session id', async () => {
    const res = await fetch(`${baseUrl}/s/main`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('"main"');
  });

  test('GET /api/sessions returns array', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/sessions creates session with given id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test-session' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; connected: boolean };
    expect(body.id).toBe('test-session');
    expect(body.connected).toBe(false);
  });

  test('POST /api/sessions auto-generates id when omitted', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toMatch(/^[a-f0-9]{8}$/);
  });

  test('POST /api/sessions returns 409 for duplicate id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'test-session' }),
    });
    expect(res.status).toBe(409);
  });

  test('POST /api/sessions returns 400 for invalid id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'INVALID ID!' }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/sessions/:id returns session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('test-session');
  });

  test('GET /api/sessions/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/does-not-exist`);
    expect(res.status).toBe(404);
  });

  test('PATCH /api/sessions/:id renames session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/test-session`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'renamed-session' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('renamed-session');

    expect((await fetch(`${baseUrl}/api/sessions/test-session`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/sessions/renamed-session`)).status).toBe(200);
  });

  test('PATCH /api/sessions/:id returns 409 for conflicting id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/renamed-session`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'main' }),
    });
    expect(res.status).toBe(409);
  });

  test('DELETE /api/sessions/:id removes session', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/renamed-session`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/sessions/renamed-session`)).status).toBe(404);
  });

  test('DELETE /api/sessions/:id returns 404 for unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/sessions/does-not-exist`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('POST /api/server/stop returns 200 and stops server', async () => {
    const res = await fetch(`${baseUrl}/api/server/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('stopping');
    await waitForServerDown(baseUrl);
    await expect(fetch(`${baseUrl}/api/sessions`)).rejects.toThrow();
  });
});
