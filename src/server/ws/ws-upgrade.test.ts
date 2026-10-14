// Tests for the WebSocket server behind the HTTP upgrade: routing `/ws/:id/pty` and
// `/ws/:id/events`, rejecting other paths, and the default PTY spawner (ADR 062).
import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type WebSocketServer } from 'ws';
import { DEFAULT_CONFIG, loadConfig } from '../../config';
import { spawnPty } from '../../pty';
import { FakePty } from '../../test-support/fake-pty';
import { sessionBanner } from '../sessions/session-banner';
import { SessionStore } from '../sessions/session-store';
import { WS_CLOSE } from './close-codes';
import { createWebSocketServer, defaultPtySpawnDeps } from './ws-upgrade';

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

afterEach(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  wss?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  wss = null;
});

/** An in-process HTTP server on port 0 with the WebSocket server attached and a fake PTY. */
async function start() {
  const store = new SessionStore();
  const log: string[] = [];
  const pty = new FakePty(log);
  server = http.createServer();
  wss = createWebSocketServer(server, store, {
    loadConfig: () => DEFAULT_CONFIG,
    spawnPty: ({ cols, rows }) => {
      log.push(`spawn ${cols}x${rows}`);
      return pty;
    },
    runner: 'bunx',
  });
  const s = server;
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address() as AddressInfo;
  return { store, log, pty, base: `ws://127.0.0.1:${port}` };
}

/** Opens `url` and resolves with the first message, or how it closed or failed. */
function firstEvent(url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('message', (data) => {
      resolve(`message ${data.toString()}`);
      ws.close();
    });
    ws.on('close', (code) => resolve(`close ${code}`));
    ws.on('error', () => resolve('error'));
  });
}

describe('createWebSocketServer', () => {
  test('a PTY socket for a session spawns its shell and receives the banner', async () => {
    const { store, log, base } = await start();
    store.create('a b');
    expect(await firstEvent(`${base}/ws/a%20b/pty?cols=90&rows=20`)).toBe(
      `message ${sessionBanner('bunx')}`,
    );
    expect(log.slice(0, 1)).toEqual(['spawn 90x20']);
    expect(store.lastUsedId).toBe('a b');
  });

  test('a PTY socket for an unknown session is closed with SESSION_GONE', async () => {
    const { base } = await start();
    expect(await firstEvent(`${base}/ws/nope/pty`)).toBe(`close ${WS_CLOSE.SESSION_GONE}`);
  });

  test('an events socket is routed to the event handler', async () => {
    const { store, base } = await start();
    store.create('s');
    expect(await firstEvent(`${base}/ws/s/events`)).toBe(`close ${WS_CLOSE.PTY_NOT_RUNNING}`);
  });

  test('an ID that is not valid percent-encoding is closed with BAD_REQUEST', async () => {
    const { base } = await start();
    expect(await firstEvent(`${base}/ws/%E0%A4%A/pty`)).toBe(`close ${WS_CLOSE.BAD_REQUEST}`);
    expect(await firstEvent(`${base}/ws/%E0%A4%A/events`)).toBe(`close ${WS_CLOSE.BAD_REQUEST}`);
  });

  test('an upgrade to any other path has its socket destroyed', async () => {
    const { base } = await start();
    expect(await firstEvent(`${base}/ws/s/other`)).toBe('error');
    expect(await firstEvent(`${base}/elsewhere`)).toBe('error');
  });

  test('a connection that bypassed the upgrade router with an unknown path is closed', async () => {
    await start();
    const closed: unknown[] = [];
    const ws = { close: (...args: unknown[]) => closed.push(args) };
    wss?.emit('connection', ws, { url: '/nope', headers: {} });
    expect(closed).toEqual([[]]);
  });
});

describe('defaultPtySpawnDeps', () => {
  test('reads the config file, spawns through src/pty and names the package runner', () => {
    const deps = defaultPtySpawnDeps();
    expect(deps.loadConfig).toBe(loadConfig);
    expect(deps.spawnPty).toBe(spawnPty);
    expect(['bunx', 'npx']).toContain(deps.runner);
  });
});
