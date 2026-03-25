import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function waitForServer(baseUrl: string, timeout = 5000): Promise<void> {
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

export async function waitForServerDown(baseUrl: string, timeout = 3000): Promise<void> {
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

export async function waitForServerReady(baseUrl: string, timeout = 5000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/sessions`);
      if (res.ok && Array.isArray(await res.json())) return true;
    } catch {
      /* empty */
    }
    await Bun.sleep(100);
  }
  return false;
}

export function makeTmpHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `webtty-${prefix}-`));
}

export function cleanupTmpHome(tmpHome: string): void {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

describe('test-helpers', () => {
  test('waitForServer throws when server never responds', async () => {
    await expect(waitForServer('http://127.0.0.1:1', 50)).rejects.toThrow(
      'Server did not start in time',
    );
  });

  test('waitForServerDown throws when server keeps responding', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    await expect(waitForServerDown('http://127.0.0.1:1', 50)).rejects.toThrow(
      'Server did not shut down in time',
    );
    globalThis.fetch = realFetch;
  });
});
