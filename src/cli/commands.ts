import * as childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../config';
import { BASE_URL, isServerRunning, openBrowser, startServer, stopServer } from './http';
import { bytesToChars, bytesToDisplay } from './key-format';

/**
 * Opens (or creates) session `id`, starts the server if needed, and opens the URL in the browser.
 *
 * @param id - The session ID to open (default: `'main'`).
 */
export async function cmdGo(id = 'main'): Promise<void> {
  if (!(await isServerRunning())) {
    await startServer();
  }

  let sessionId: string;
  const check = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}`);
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

  const url = `${BASE_URL}/s/${sessionId}`;
  console.log(url);
  openBrowser(url);
}

/**
 * Lists all active sessions, optionally filtered by a substring of the session ID.
 *
 * @param filter - Optional substring to filter session IDs.
 */
export async function cmdList(filter?: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/sessions`);
  } catch {
    console.log('webtty is not running');
    process.exit(1);
  }
  const all = (await res.json()) as Array<{
    id: string;
    connected: boolean;
    createdAt: number;
  }>;
  const sessions = filter ? all.filter((s) => s.id.includes(filter)) : all;
  if (sessions.length === 0) {
    console.log('no sessions');
    return;
  }
  console.log('id\t\t\tconnected\tcreated');
  for (const s of sessions) {
    const created = new Date(s.createdAt).toLocaleString();
    console.log(`${s.id}\t\t\t${s.connected}\t\t${created}`);
  }
}

/**
 * Removes session `id` and stops the server if no sessions remain.
 *
 * @param id - The session ID to remove.
 */
export async function cmdRemove(id?: string): Promise<void> {
  if (!id) {
    console.error('webtty: rm requires a session id');
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  } catch {
    console.log('webtty is not running');
    process.exit(1);
  }
  if (res.status === 204) {
    console.log(`removed ${id}`);
    if (res.headers.get('x-sessions-remaining') === '0') {
      await stopServer();
      console.log('no sessions remaining — webtty stopped');
    }
  } else if (res.status === 404) {
    console.error(`session ${id} not found`);
    process.exit(1);
  } else {
    console.error(`webtty rm failed (status: ${res.status})`);
    process.exit(1);
  }
}

/**
 * Renames session `id` to `newId`.
 *
 * @param id - The current session ID.
 * @param newId - The new session ID.
 */
export async function cmdRename(id?: string, newId?: string): Promise<void> {
  if (!id || !newId) {
    console.error('webtty: rename requires two arguments: [id] [new-id]');
    process.exit(1);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/sessions/${encodeURIComponent(id)}`, {
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
}

/** Stops the server if it is running. */
export async function cmdStop(): Promise<void> {
  if (!(await isServerRunning())) {
    console.log('webtty is not running');
    return;
  }
  const ok = await stopServer();
  if (ok) {
    console.log('webtty stopped');
  } else {
    console.error('webtty stop failed');
    process.exit(1);
  }
}

/** Starts the server if it is not already running. */
export async function cmdStart(): Promise<void> {
  if (await isServerRunning()) {
    console.log('webtty is already running');
    return;
  }
  await startServer();
  console.log('webtty started');
}

/** Opens `~/.config/webtty/config.json` in `$VISUAL` / `$EDITOR`, creating it if absent. */
export function cmdConfig(): void {
  const dir = configDir();
  const configPath = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, '{}\n', 'utf8');
  }
  const editor =
    process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi');
  childProcess.spawnSync(editor, [configPath], { stdio: 'inherit' });
}

export function cmdKey(): void {
  if (!process.stdin.isTTY) {
    console.error('webtty key: requires an interactive terminal');
    process.exit(1);
  }

  /* v8 ignore start */
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  process.stdin.setRawMode(true);
  process.stdin.resume();
  console.log('Press any key combo to see its chars value. q to quit.\n');
  console.log(`  ${dim}received${reset} →  ${bold}chars${reset}`);
  console.log(`  ${'─'.repeat(17)}`);

  let buf = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    const display = bytesToDisplay(buf).padEnd(8);
    console.log(`  ${dim}${display}${reset} →  ${bold}${bytesToChars(buf)}${reset}`);
    buf = Buffer.alloc(0);
  };

  process.stdin.on('data', (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === 0x71) {
      process.stdin.setRawMode(false);
      console.log(`  ${'─'.repeat(17)}\n`);
      process.exit(0);
    }
    buf = Buffer.concat([buf, chunk]);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 50);
  });
  /* v8 ignore end */
}
