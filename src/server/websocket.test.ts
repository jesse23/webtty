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
    const ws = new WebSocket(`${wsBase}/ws/no-such-session/pty`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  test('first connection spawns PTY and sends welcome banner', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-banner' }),
    });

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-banner/pty?cols=80&rows=24`);
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
      `${wsBase}/ws/ws-test-replay/pty?cols=80&rows=24`,
    );
    await waitForMessages(m1, 1);
    await closeWs(ws1);

    const { ws: ws2, messages: m2 } = await connectWs(
      `${wsBase}/ws/ws-test-replay/pty?cols=80&rows=24`,
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
      `${wsBase}/ws/ws-test-fanout/pty?cols=80&rows=24`,
    );
    await waitForMessages(m1, 1);

    const { ws: ws2, messages: m2 } = await connectWs(
      `${wsBase}/ws/ws-test-fanout/pty?cols=80&rows=24`,
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

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-exit/pty?cols=80&rows=24`);
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

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-resize/pty?cols=80&rows=24`);
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

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-pid-route/pty?cols=80&rows=24`);
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

  test('GET /ws/:id/events rejects with 4001 for non-existent session', async () => {
    const ws = new WebSocket(`${wsBase}/ws/no-such-session/events`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4001);
  });

  test('GET /ws/:id/events rejects with 4002 when PTY not running', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'events-no-pty' }),
    });
    const ws = new WebSocket(`${wsBase}/ws/events-no-pty/events`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4002);
  });

  test('subscriber receives published event', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'events-pubsub' }),
    });
    const { ws: ptyWs, messages: ptyMessages } = await connectWs(
      `${wsBase}/ws/events-pubsub/pty?cols=80&rows=24`,
    );
    await waitForMessages(ptyMessages, 1);

    const { ws: subWs, messages: subMessages } = await connectWs(
      `${wsBase}/ws/events-pubsub/events`,
    );

    await fetch(`${baseUrl}/s/events-pubsub/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test', value: 42 }),
    });

    await waitForMessages(subMessages, 1);
    expect(JSON.parse(subMessages[0])).toEqual({ type: 'test', value: 42 });

    await closeWs(subWs);
    await closeWs(ptyWs);
  });

  test('multi-line publish delivers one frame per line', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'events-multiline' }),
    });
    const { ws: ptyWs, messages: ptyMessages } = await connectWs(
      `${wsBase}/ws/events-multiline/pty?cols=80&rows=24`,
    );
    await waitForMessages(ptyMessages, 1);

    const { ws: subWs, messages: subMessages } = await connectWs(
      `${wsBase}/ws/events-multiline/events`,
    );

    await fetch(`${baseUrl}/s/events-multiline/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: [{ seq: 1 }, { seq: 2 }, { seq: 3 }].map((o) => JSON.stringify(o)).join('\n'),
    });

    await waitForMessages(subMessages, 3);
    expect(JSON.parse(subMessages[0])).toEqual({ seq: 1 });
    expect(JSON.parse(subMessages[1])).toEqual({ seq: 2 });
    expect(JSON.parse(subMessages[2])).toEqual({ seq: 3 });

    await closeWs(subWs);
    await closeWs(ptyWs);
  });

  test('invalid JSON lines are silently skipped', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'events-skip-invalid' }),
    });
    const { ws: ptyWs, messages: ptyMessages } = await connectWs(
      `${wsBase}/ws/events-skip-invalid/pty?cols=80&rows=24`,
    );
    await waitForMessages(ptyMessages, 1);

    const { ws: subWs, messages: subMessages } = await connectWs(
      `${wsBase}/ws/events-skip-invalid/events`,
    );

    await fetch(`${baseUrl}/s/events-skip-invalid/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: [JSON.stringify({ seq: 1 }), 'not valid json', JSON.stringify({ seq: 2 })].join('\n'),
    });

    await waitForMessages(subMessages, 2);
    expect(JSON.parse(subMessages[0])).toEqual({ seq: 1 });
    expect(JSON.parse(subMessages[1])).toEqual({ seq: 2 });
    expect(subMessages.length).toBe(2);

    await closeWs(subWs);
    await closeWs(ptyWs);
  });

  test('subscribers are closed with 4001 when shell exits', async () => {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'events-shell-exit' }),
    });
    const { ws: ptyWs, messages: ptyMessages } = await connectWs(
      `${wsBase}/ws/events-shell-exit/pty?cols=80&rows=24`,
    );
    await waitForMessages(ptyMessages, 1);
    await waitForPrompt(ptyMessages);

    const { ws: subWs } = await connectWs(`${wsBase}/ws/events-shell-exit/events`);
    const closeCode = new Promise<number>((resolve) => subWs.on('close', (c) => resolve(c)));

    ptyWs.send(`exit${NL}`);
    expect(await closeCode).toBe(4001);
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

    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-last/pty?cols=80&rows=24`);
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
