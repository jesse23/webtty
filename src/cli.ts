import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 2346;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function isServerRunning(): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/api/sessions`);
    return true;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  const isTs = __filename.endsWith('.ts');
  const serverEntry = path.resolve(__dirname, isTs ? 'server.ts' : 'server.js');
  if (!fs.existsSync(serverEntry)) {
    console.error(`webtty: server entry not found at ${serverEntry}`);
    process.exit(1);
  }
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

function openBrowser(url: string): void {
  if (process.env.WEBTTY_NO_OPEN === '1') return;
  const cmd =
    process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
}

const program = new Command();
program.name('webtty').description('Web TTY — run terminal sessions in a browser tab');

program
  .command('start')
  .description('Start the webtty server')
  .action(async () => {
    if (await isServerRunning()) {
      console.log('webtty is already running');
      return;
    }
    await startServer();
    console.log('webtty started');
  });

program
  .command('stop')
  .description('Stop the webtty server')
  .action(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/server/stop`, { method: 'POST' });
      if (res.ok) {
        console.log('webtty stopped');
      } else {
        console.error(`webtty stop failed (status: ${res.status})`);
        process.exit(1);
      }
    } catch {
      console.log('webtty is not running');
    }
  });

program
  .command('ls')
  .description('List all sessions')
  .action(async () => {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/sessions`);
    } catch {
      console.log('webtty is not running');
      process.exit(1);
    }
    const sessions = (await res.json()) as Array<{
      id: string;
      connected: boolean;
      createdAt: number;
    }>;
    if (sessions.length === 0) {
      console.log('no sessions');
      return;
    }
    console.log('id\t\t\tconnected\tcreated');
    for (const s of sessions) {
      const created = new Date(s.createdAt).toLocaleString();
      console.log(`${s.id}\t\t\t${s.connected}\t\t${created}`);
    }
  });

program
  .command('run [id]')
  .description('Create or reuse a session and open it in the browser')
  .action(async (id?: string) => {
    if (!(await isServerRunning())) {
      await startServer();
    }

    let sessionId: string;
    if (id) {
      const check = await fetch(`${BASE_URL}/api/sessions/${id}`);
      if (check.status === 200) {
        sessionId = id;
      } else {
        const res = await fetch(`${BASE_URL}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          console.error(`webtty: ${body.error ?? `failed to create session (${res.status})`}`);
          process.exit(1);
        }
        const session = (await res.json()) as { id: string };
        sessionId = session.id;
      }
    } else {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        console.error(`webtty: ${body.error ?? `failed to create session (${res.status})`}`);
        process.exit(1);
      }
      const session = (await res.json()) as { id: string };
      sessionId = session.id;
    }

    const url = `${BASE_URL}/s/${sessionId}`;
    console.log(url);
    openBrowser(url);
  });

program
  .command('rm <id>')
  .description('Kill a session and its PTY')
  .action(async (id: string) => {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/sessions/${id}`, { method: 'DELETE' });
    } catch {
      console.log('webtty is not running');
      process.exit(1);
    }
    if (res.status === 204) {
      console.log(`removed ${id}`);
    } else if (res.status === 404) {
      console.error(`session ${id} not found`);
      process.exit(1);
    } else {
      console.error(`webtty rm failed (status: ${res.status})`);
      process.exit(1);
    }
  });

program
  .command('rename <id> <new-id>')
  .description('Rename a session')
  .action(async (id: string, newId: string) => {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newId }),
      });
    } catch {
      console.log('webtty is not running');
      process.exit(1);
    }
    if (res.ok) {
      console.log(`renamed ${id} → ${newId}`);
    } else if (res.status === 404) {
      console.error(`session ${id} not found`);
      process.exit(1);
    } else {
      const body = (await res.json()) as { error?: string };
      console.error(`webtty: ${body.error ?? `rename failed (${res.status})`}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
