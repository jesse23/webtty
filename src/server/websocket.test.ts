import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { cleanupTmpHome, getFreePort, makeTmpHome, waitForServer } from '../utils.test';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

// cmd.exe requires CR+LF to execute commands; sh/bash accept LF alone.
const NL = process.platform === 'win32' ? '\r\n' : '\n';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// On Windows, Bun's ConPTY/net.Socket integration doesn't support the pipe
// handles node-pty requires. Mirror the same workaround as http.ts: run the
// server under Node when on Windows+Bun so node-pty works correctly.
const isBun = typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
const useNode = process.platform === 'win32' && isBun;
const SERVER_EXEC = useNode ? 'node' : process.execPath;
const SERVER_ENTRY = useNode
  ? path.resolve(__dirname, '../../dist/server/index.js')
  : path.resolve(__dirname, 'index.ts');

function connectWs(wsUrl: string): Promise<{ ws: WebSocket; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages: string[] = [];
    ws.on('message', (data) => messages.push(data.toString()));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

function waitForMessages(messages: string[], count: number, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (messages.length >= count) return resolve();
      if (Date.now() > deadline)
        return reject(new Error(`Timeout waiting for ${count} messages, got ${messages.length}`));
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForPrompt(messages: string[], timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      const all = messages.join('');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is intentional — matching terminal escape sequences in PTY output
      if (all.includes('\x1b]133;B') || all.match(/[$%#>➜](?:\s|\x1b|$)/m)) return resolve();
      if (Date.now() > deadline) return reject(new Error('Timeout waiting for shell prompt'));
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForContent(messages: string[], content: string, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (messages.join('').includes(content)) return resolve();
      if (Date.now() > deadline)
        return reject(new Error(`Timeout waiting for content: ${content}`));
      setTimeout(check, 50);
    };
    check();
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on('close', () => resolve());
    ws.close();
  });
}

describe('websocket', () => {
  let proc: ChildProcess;
  let baseUrl: string;
  let wsBase: string;
  let port: number;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = makeTmpHome('ws-test');
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    proc = spawn(SERVER_EXEC, [SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(port),
        HOME: tmpHome,
        // Let the server resolve the shell via its own platform detection (config.ts).
        // Forcing /bin/sh here breaks Windows where that path does not exist.
        ...(process.platform !== 'win32' && { SHELL: '/bin/sh' }),
        // On Windows, clink (if installed) auto-injects into cmd.exe and breaks PTY socket writes.
        ...(process.platform === 'win32' && { CLINK_NOAUTORUN: '1' }),
      },
      stdio: 'ignore',
    });
    await waitForServer(baseUrl);
  });

  afterAll(() => {
    proc.kill();
    cleanupTmpHome(tmpHome);
  });

  test('rejects connection for non-existent session with code 4001', async () => {
    const ws = new WebSocket(`${wsBase}/ws/no-such-session`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  test('first connection spawns PTY and sends welcome banner', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-banner' }),
    });

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-banner?cols=80&rows=24`);
    await waitForMessages(messages, 1);
    await closeWs(ws);

    expect(stripAnsi(messages.join(''))).toContain('webtty');
  });

  test('reconnect replays scrollback without banner', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-replay' }),
    });

    const { ws: ws1, messages: m1 } = await connectWs(
      `${wsBase}/ws/ws-test-replay?cols=80&rows=24`,
    );
    await waitForMessages(m1, 1);
    await closeWs(ws1);

    const { ws: ws2, messages: m2 } = await connectWs(
      `${wsBase}/ws/ws-test-replay?cols=80&rows=24`,
    );
    await waitForMessages(m2, 1);
    await closeWs(ws2);

    const replay = stripAnsi(m2.join(''));
    expect(replay).toContain('webtty');
    expect(replay.indexOf('Terminal UI')).toBe(replay.lastIndexOf('Terminal UI'));
  });

  test('multiple clients receive same PTY output', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-fanout' }),
    });

    const { ws: ws1, messages: m1 } = await connectWs(
      `${wsBase}/ws/ws-test-fanout?cols=80&rows=24`,
    );
    await waitForMessages(m1, 1);

    const { ws: ws2, messages: m2 } = await connectWs(
      `${wsBase}/ws/ws-test-fanout?cols=80&rows=24`,
    );
    await waitForMessages(m2, 1);

    await waitForPrompt(m1);

    ws1.send(`echo hello-fanout${NL}`);
    await waitForContent(m1, 'hello-fanout');
    await waitForContent(m2, 'hello-fanout');

    await closeWs(ws1);
    await closeWs(ws2);

    expect(m1.join('')).toContain('hello-fanout');
    expect(m2.join('')).toContain('hello-fanout');
  });

  test('session is removed and tab closed when shell exits', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-exit' }),
    });

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-exit?cols=80&rows=24`);
    await waitForMessages(messages, 1);

    const closeCode = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send(`exit${NL}`);
    expect(await closeCode).toBe(4001);

    const res = await fetch(`${baseUrl}/api/sessions/ws-test-exit`);
    expect(res.status).toBe(404);
  });

  test('resize message updates PTY dimensions', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-resize' }),
    });

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-resize?cols=80&rows=24`);
    await waitForMessages(messages, 1);
    await waitForPrompt(messages);

    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    ws.send(`echo resize-ok${NL}`);
    await waitForContent(messages, 'resize-ok');
    await closeWs(ws);

    expect(messages.join('')).toContain('resize-ok');
  });

  test('GET /p/:pid redirects to session URL after PTY spawns', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-pid-route' }),
    });

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-pid-route?cols=80&rows=24`);
    await waitForMessages(messages, 1);
    await closeWs(ws);

    const sessions = (await fetch(`${baseUrl}/api/sessions`).then((r) => r.json())) as Array<{
      id: string;
      pid: number | null;
    }>;
    const session = sessions.find((s) => s.id === 'ws-test-pid-route');
    expect(session).toBeDefined();
    expect(typeof session?.pid).toBe('number');

    const res = await fetch(`${baseUrl}/p/${session?.pid}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/s/ws-test-pid-route');
  });

  test('server shuts down when last session exits', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-last' }),
    });

    const allSessions = (await fetch(`${baseUrl}/api/sessions`).then((r) => r.json())) as unknown[];
    for (const s of allSessions as Array<{ id: string }>) {
      if (s.id !== 'ws-test-last') {
        await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      }
    }

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-last?cols=80&rows=24`);
    await waitForMessages(messages, 1);

    ws.send(`exit${NL}`);
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        await fetch(`${baseUrl}/api/sessions`);
        await Bun.sleep(100);
      } catch {
        return;
      }
    }
    throw new Error('Server did not shut down after last session exited');
  });
});
