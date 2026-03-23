import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const PORT = Number(process.env.PORT) || 2346;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export async function isServerRunning(): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/api/sessions`);
    return true;
  } catch {
    return false;
  }
}

export async function startServer(): Promise<void> {
  // Detect whether we're running from source (.ts) or built output (.js) and
  // resolve the matching server entry accordingly.
  const isTs = __filename.endsWith('.ts');
  const serverEntry = path.resolve(__dirname, isTs ? '../server/index.ts' : '../server/index.js');
  if (!fs.existsSync(serverEntry)) {
    console.error(`webtty: server entry not found at ${serverEntry}`);
    process.exit(1);
  }
  // Reuse the current runtime (bun, node, etc.) to spawn the server so the
  // server always runs under the same runtime as the CLI.
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isServerRunning()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('webtty: server did not start in time');
  process.exit(1);
}

export function openBrowser(url: string): void {
  if (process.env.WEBTTY_NO_OPEN === '1') return;
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}
