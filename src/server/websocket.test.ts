import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { cleanupTmpHome, getFreePort, makeTmpHome, waitForServer } from '../utils.test';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, 'index.ts');

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
    proc = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, PORT: String(port), HOME: tmpHome },
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

    await Bun.sleep(2500);

    const before1 = m1.length;
    const before2 = m2.length;

    ws1.send('echo hello-fanout\n');
    await waitForMessages(m1, before1 + 1);
    await waitForMessages(m2, before2 + 1);

    await closeWs(ws1);
    await closeWs(ws2);

    expect(m1.slice(before1).join('')).toContain('hello-fanout');
    expect(m2.slice(before2).join('')).toContain('hello-fanout');
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
    ws.send('exit\n');
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

    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    await Bun.sleep(2500);
    const before = messages.length;
    ws.send('echo resize-ok\n');
    await waitForMessages(messages, before + 1);
    await closeWs(ws);

    expect(messages.slice(before).join('')).toContain('resize-ok');
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

    ws.send('exit\n');
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
