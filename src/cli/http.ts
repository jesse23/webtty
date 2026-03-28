import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig } from '../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Active server port, resolved from `PORT` env or config default. */
export const PORT = Number(process.env.PORT) || 2346;

/** Base URL for the local server (always 127.0.0.1). */
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Returns the path to the server log file: `~/.config/webtty/server.log`. */
export function logPath(): string {
  return path.join(configDir(), 'server.log');
}

/** Returns `true` if the webtty server is reachable and responding to API requests. */
export async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body);
  } catch {
    return false;
  }
}

/** Spawns the server process detached, then polls until it is ready or `timeoutMs` expires. */
export async function startServer(timeoutMs = 10000, _spawn = childProcess.spawn): Promise<void> {
  const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
  const isTs = isBun && __filename.endsWith('.ts');
  const serverEntry = path.resolve(__dirname, isTs ? '../server/index.ts' : '../server/index.js');
  if (!fs.existsSync(serverEntry)) {
    console.error(`webtty: server entry not found at ${serverEntry}`);
    process.exit(1);
  }

  const config = loadConfig();
  let stdio: childProcess.SpawnOptions['stdio'] = 'ignore';
  let logFd: number | undefined;
  if (config.logs) {
    const log = logPath();
    fs.mkdirSync(path.dirname(log), { recursive: true });
    logFd = fs.openSync(log, 'a');
    stdio = ['ignore', logFd, logFd];
  }

  const child = _spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio,
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  if (logFd !== undefined) fs.closeSync(logFd);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerRunning()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('webtty: server did not start in time');
  process.exit(1);
}

/** Sends `POST /api/server/stop`, then polls until the server is no longer reachable. Returns `true` on success. */
export async function stopServer(baseUrl: string = BASE_URL, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/server/stop`, { method: 'POST' });
    if (!res.ok) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await isServerRunning())) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } catch {
    return false;
  }
}

/** Opens `url` in the default system browser. No-op in test environments or when `WEBTTY_NO_OPEN=1`. */
export function openBrowser(url: string, _spawn = childProcess.spawn): void {
  if (process.env.WEBTTY_NO_OPEN === '1') return;
  if (process.env.NODE_ENV === 'test') return;
  if (process.platform === 'win32') {
    _spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    _spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
