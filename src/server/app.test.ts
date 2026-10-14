import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocket } from 'ws';
import { type Config, DEFAULT_CONFIG } from '../config';
import { FakePty } from '../test-support/fake-pty';
import { cleanupTmpHome, makeTmpHome } from '../test-support/server-harness';
import { getVersion } from '../version';
import { createServer, type WebttyServer } from './app';
import type { ServerPaths } from './server-paths';
import { SessionStore } from './sessions/session-store';

let tmpDir = '';
let paths: ServerPaths;
let running: WebttyServer | null = null;

beforeAll(() => {
  tmpDir = makeTmpHome('app');
  fs.writeFileSync(path.join(tmpDir, 'client.html'), '<p>client</p>');
  fs.writeFileSync(path.join(tmpDir, 'ghostty-vt-small.wasm'), 'wasm');
  paths = {
    projectRoot: tmpDir,
    clientRoot: tmpDir,
    wasmPath: path.join(tmpDir, 'ghostty-vt-small.wasm'),
  };
});

afterAll(() => cleanupTmpHome(tmpDir));

afterEach(async () => {
  const server = running;
  running = null;
  if (!server?.httpServer.listening) return;
  server.httpServer.closeAllConnections();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
});

/** Builds the server with a fake PTY and a counting stop hook, listening on port 0. */
async function start(loadConfig: () => Config = () => DEFAULT_CONFIG) {
  const log: string[] = [];
  const pty = new FakePty(log);
  const stops: string[] = [];
  const store = new SessionStore();
  const server = createServer({
    loadConfig,
    store,
    paths,
    spawnPty: (cols, rows) => {
      log.push(`spawn ${cols}x${rows}`);
      return pty;
    },
    onStop: () => stops.push('stop'),
  });
  running = server;
  await new Promise<void>((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = server.httpServer.address() as AddressInfo;
  return { server, store, log, pty, stops, port, base: `http://127.0.0.1:${port}` };
}

/** Polls `cond` every 5 ms for up to 2 s. */
async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}

describe('createServer', () => {
  test('serves the routes once listening: GET /api/server/status', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/server/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ version: getVersion() });
  });

  test('serves the client page and the wasm from the given paths', async () => {
    const { base } = await start();
    await fetch(`${base}/api/sessions`, { method: 'POST', body: '{"id":"x"}' });
    expect(await (await fetch(`${base}/s/x`)).text()).toBe('<p>client</p>');
    expect(await (await fetch(`${base}/ghostty-vt-small.wasm`)).text()).toBe('wasm');
  });

  test('calls loadConfig on every config request, never caching it', async () => {
    let calls = 0;
    const { base } = await start(() => {
      calls++;
      return { ...DEFAULT_CONFIG, fontSize: 10 + calls };
    });
    const first = await (await fetch(`${base}/api/config`)).json();
    const second = await (await fetch(`${base}/api/config`)).json();
    expect([first.fontSize, second.fontSize]).toEqual([11, 12]);
  });

  test('answers 500 when a route throws before writing', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { base } = await start(() => {
      throw new Error('bad config');
    });
    const res = await fetch(`${base}/api/config`);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
    expect(errorSpy).toHaveBeenCalledWith('[webtty] unhandled route error:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('a PTY socket spawns its shell with the injected spawner', async () => {
    const { store, log, port } = await start();
    store.create('x');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/x/pty?cols=90&rows=30`);
    await until(() => log.includes('spawn 90x30'));
    ws.terminate();
  });

  test('shutdown closes sockets as the server stops, kills shells, then calls onStop', async () => {
    const { server, store, log, stops, port } = await start();
    store.create('x');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/x/pty`);
    const closed = new Promise<string>((resolve) =>
      ws.on('close', (_code, r) => resolve(String(r))),
    );
    await until(() => log.some((e) => e.startsWith('spawn')));

    server.shutdown();

    // The reason is the one closeAll(SERVER_STOPPED) sends; Bun's ws client reports the
    // 1001 code as 1000, so the code itself is pinned by session.test.ts.
    expect(await closed).toBe('server stopped');
    expect(log).toContain('pty.kill');
    await until(() => stops.length > 0);
    expect(server.httpServer.listening).toBe(false);
  });

  test('POST /api/server/stop replies, then shuts the server down', async () => {
    const { base, stops, server } = await start();
    const res = await fetch(`${base}/api/server/stop`, { method: 'POST' });
    expect(await res.text()).toBe('stopping');
    server.httpServer.closeAllConnections();
    await until(() => stops.length > 0);
    expect(stops).toEqual(['stop']);
  });
});
