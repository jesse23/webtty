import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig } from '../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Active server port, read from config on first call (env PORT is intentionally ignored). */
export function getPort(): number {
  return loadConfig().port;
}

/** Base URL for internal CLI↔server API calls (always 127.0.0.1, avoids IPv6 lookup). */
export function getBaseUrl(): string {
  return `http://127.0.0.1:${getPort()}`;
}

/** Returns the path to the server log file: `~/.config/webtty/server.log`. */
export function logPath(): string {
  return path.join(configDir(), 'server.log');
}

/** Returns `true` if the webtty server is reachable and responding to API requests. */
export async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/sessions`);
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body);
  } catch {
    return false;
  }
}

/**
 * Spawns the server process detached, then polls until it is ready or `timeoutMs` expires.
 *
 * @param timeoutMs - Maximum time to wait for the server to start (default: 10000 ms).
 * @param _spawn - Spawn function override for testing (default: childProcess.spawn).
 * @throws Exits the process with code 1 if the server entry is not found or fails to start in time.
 */
export async function startServer(timeoutMs = 10000, _spawn = childProcess.spawn): Promise<void> {
  const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

  // On Windows, Bun's net.Socket doesn't support the fd-based named-pipe
  // wrapping that node-pty's ConPTY backend requires, so node-pty fails under
  // Bun on Windows. bunx works because its #!/usr/bin/env node shim runs the
  // server with Node.js instead. Mirror that here explicitly.
  const useNode = process.platform === 'win32' && isBun;
  const serverExec = useNode ? 'node' : process.execPath;

  // Resolve the server entry. When useNode is true the executor is Node.js,
  // which cannot run .ts files, so we always need the compiled .js output.
  // The CLI may itself run from source (src/cli/) or from dist (dist/cli/);
  // adjust the relative path accordingly so we always land in the same dist/.
  const runningFromSrc = __filename.endsWith('.ts');
  let serverEntry: string;
  if (useNode) {
    serverEntry = runningFromSrc
      ? path.resolve(__dirname, '../../dist/server/index.js') // src/cli → dist/server
      : path.resolve(__dirname, '../server/index.js'); // dist/cli → dist/server
  } else {
    serverEntry = path.resolve(
      __dirname,
      runningFromSrc ? '../server/index.ts' : '../server/index.js',
    );
  }
  if (!fs.existsSync(serverEntry)) {
    console.error(`webtty: server entry not found at ${serverEntry}`);
    (process.exit as (code?: number) => void)(1);
    return;
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

  const child = _spawn(serverExec, [serverEntry], {
    detached: true,
    stdio,
    env: { ...process.env, PORT: String(getPort()) },
  });
  child.on('error', (err) => {
    const hint = useNode
      ? ' (Node.js must be on PATH when running webtty under Bun on Windows)'
      : '';
    console.error(`webtty: failed to start server: ${err.message}${hint}`);
    process.exit(1);
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

/**
 * Sends `POST /api/server/stop`, then polls until the server is no longer reachable.
 *
 * @param baseUrl - The server base URL (default: getBaseUrl()).
 * @param timeoutMs - Maximum time to wait for the server to stop (default: 5000 ms).
 * @returns `true` if the server stopped successfully, `false` otherwise.
 */
export async function stopServer(
  baseUrl: string = getBaseUrl(),
  timeoutMs = 5000,
): Promise<boolean> {
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

/**
 * Opens `url` in the default system browser.
 * No-op in test environments or when `WEBTTY_NO_OPEN=1` is set.
 *
 * @param url - The URL to open.
 * @param _spawn - Spawn function override for testing (default: childProcess.spawn).
 */
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
