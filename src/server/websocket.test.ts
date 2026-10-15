// Behaviour tests for the two WebSocket channels, /ws/:id/pty and /ws/:id/events, against
// the whole server built in-process by createServer with real shells: banner and replay,
// fan-out, flow control, resize, shell exit and the stop once the last session ends
// (ADR 062, ADR 064). The tests share one server and run in order.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';
import { isWindows, runningUnderBun } from '../runtime';
import { type LiveServer, startLiveServer } from '../test-support/live-server';
import { type TmpHome, useTmpHome } from '../test-support/server-harness';
import { resolveServerPaths } from './server-paths';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');

// cmd.exe requires CR+LF to execute commands; sh/bash accept LF alone.
const NL = process.platform === 'win32' ? '\r\n' : '\n';

// On Windows, Bun's ConPTY/net.Socket integration doesn't support the pipe handles node-pty
// requires, so these real-shell tests cannot run in a Bun test process there.
const noPtyInProcess = isWindows() && runningUnderBun();

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

describe.skipIf(noPtyInProcess)('websocket', () => {
  let live: LiveServer;
  let baseUrl: string;
  let wsBase: string;
  let home: TmpHome;

  beforeAll(async () => {
    home = useTmpHome('ws-test');
    live = await startLiveServer({ paths: resolveServerPaths() });
    baseUrl = live.base;
    wsBase = live.wsBase;
  });

  afterAll(() => {
    live.close();
    home.restore();
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

  test.skipIf(process.platform === 'win32')(
    'output to an acknowledging client stops at the high-water mark and resumes in order',
    async () => {
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ws-test-flow' }),
      });
      const { ws, messages } = await connectWs(
        `${wsBase}/ws/ws-test-flow/pty?cols=80&rows=24&flow=1`,
      );
      const received = () => messages.reduce((n, m) => n + m.length, 0);
      const ack = () => ws.send(JSON.stringify({ type: 'ack', chars: received() }));
      await waitForPrompt(messages);
      ack();

      // About 3.1 million characters, more than the 2 Mi-character window.
      const N = 400_000;
      ws.send(`seq 1 ${N}; echo FLOW-$((40+2))${NL}`);
      await new Promise((r) => setTimeout(r, 1500));
      const held = received();
      expect(held).toBeGreaterThan(1024 * 1024);
      expect(held).toBeLessThan(2 * 1024 * 1024 + 256 * 1024);
      expect(messages.join('')).not.toContain('FLOW-42');

      const deadline = Date.now() + 20000;
      while (!messages.join('').includes('FLOW-42') && Date.now() < deadline) {
        ack();
        await new Promise((r) => setTimeout(r, 20));
      }
      await closeWs(ws);

      // Under load the PTY sometimes writes `\r\r\n` for a newline (seen on macOS);
      // the extra `\r` comes from the tty, not from the server.
      const numbers = messages
        .join('')
        .split(/\r+\n/)
        .filter((l) => /^\d+$/.test(l))
        .map(Number);
      expect(numbers.length).toBe(N);
      expect(numbers.every((n, i) => n === i + 1)).toBe(true);
    },
    30000,
  );

  test.skipIf(process.platform === 'win32')(
    'a client behind the output is sent the rest before the shell-exit close',
    async () => {
      await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'ws-test-exit-tail' }),
      });
      const { ws, messages } = await connectWs(
        `${wsBase}/ws/ws-test-exit-tail/pty?cols=80&rows=24&flow=1`,
      );
      const received = () => messages.reduce((n, m) => n + m.length, 0);
      const ack = () => ws.send(JSON.stringify({ type: 'ack', chars: received() }));
      await waitForPrompt(messages);
      ack();
      const closeCode = new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));

      // More than the 2 Mi-character window, so the tail is still queued when the shell exits.
      ws.send(`seq 1 400000; echo TAIL-$((40+2)); exit${NL}`);
      await new Promise((r) => setTimeout(r, 1000));
      expect(messages.join('')).not.toContain('TAIL-42');
      ws.on('message', ack);
      ack();

      expect(await closeCode).toBe(4001);
      expect(messages.join('')).toContain('TAIL-42');
    },
    15000,
  );

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

  test('GET / redirects to the last-used session, through a rename and until it is deleted', async () => {
    const redirect = async () =>
      (await fetch(`${baseUrl}/`, { redirect: 'manual' })).headers.get('location');
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-last-used' }),
    });
    const { ws, messages } = await connectWs(`${wsBase}/ws/ws-test-last-used/pty?cols=80&rows=24`);
    await waitForMessages(messages, 1);
    await closeWs(ws);
    expect(await redirect()).toBe('/s/ws-test-last-used');

    await fetch(`${baseUrl}/api/sessions/ws-test-last-used`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'ws-test-last-renamed' }),
    });
    expect(await redirect()).toBe('/s/ws-test-last-renamed');

    await fetch(`${baseUrl}/api/sessions/ws-test-last-renamed`, { method: 'DELETE' });
    expect(await redirect()).toBe('/s/main');
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

    // Shutdown closes the listener at once; onStop follows after the shutdown grace.
    const deadline = Date.now() + 3000;
    while (live.server.httpServer.listening && Date.now() < deadline) await Bun.sleep(10);
    expect(live.server.httpServer.listening).toBe(false);
    expect(live.store.size).toBe(0);
  });
});
