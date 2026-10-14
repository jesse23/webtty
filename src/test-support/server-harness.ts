// Test harness shared by the server, CLI and version tests: free ports, readiness polling and
// throwaway HOME directories. A test-support utility module, never collected as a test (ADR 062, ADR 064).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Asks the OS for an unused loopback port so server tests never collide with a running webtty. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Polls /api/sessions until the server answers at all; throws after `timeout` ms. */
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

/** Polls /api/sessions until the connection fails, proving the server has stopped; throws after `timeout` ms. */
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

/** Polls until /api/sessions returns a JSON array; resolves false (never throws) on timeout, for CLI start checks. */
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

/** Creates a fresh temp directory to use as HOME, keeping tests away from the user's real config. */
export function makeTmpHome(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `webtty-${prefix}-`));
}

/** Removes a temp HOME made by makeTmpHome. */
export function cleanupTmpHome(tmpHome: string): void {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}
