// Tests for WebttyClient over a scripted fetch and fake sockets: every request it makes, how it
// reads replies and the NDJSON execute stream, and the configured client's base URL (ADR 063).
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTmpHome, makeTmpHome } from '../test-support/server-harness';
import { configuredClient, localBaseUrl, ServerUnreachableError, WebttyClient } from './api-client';
import {
  FAKE_BASE_URL,
  fakeSockets,
  json,
  lines,
  ndjson,
  type Responder,
  refused,
  type SocketBehaviour,
  scriptedFetch,
} from './test-support/scripted-fetch';

function clientFor(routes: Record<string, Responder>, socket?: SocketBehaviour) {
  const { fetchFn, requests } = scriptedFetch(routes);
  const sockets = fakeSockets(socket);
  return {
    client: new WebttyClient(FAKE_BASE_URL, fetchFn, sockets.openSocket),
    requests,
    sockets,
  };
}

/** Collects every message of an execute stream. */
async function collect(messages: AsyncIterable<Record<string, unknown>> | null) {
  const all: Array<Record<string, unknown>> = [];
  for await (const message of messages ?? []) all.push(message);
  return all;
}

describe('localBaseUrl and configuredClient', () => {
  test('the base URL is always 127.0.0.1 on the given port', () => {
    expect(localBaseUrl(7681)).toBe('http://127.0.0.1:7681');
  });

  test('configuredClient builds a client without reading the config yet', () => {
    expect(configuredClient()).toBeInstanceOf(WebttyClient);
  });

  test("configuredClient's base URL is the config file's port, read per request", async () => {
    const home = makeTmpHome('api-client');
    const savedHome = process.env.HOME;
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    const writePort = (port: number) => {
      fs.mkdirSync(path.join(home, '.config', 'webtty'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.config', 'webtty', 'config.json'),
        JSON.stringify({ port }),
      );
    };
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        seen.push(String(url));
        return json([]);
      },
      { preconnect: realFetch.preconnect },
    );
    process.env.HOME = home;
    try {
      const client = configuredClient();
      writePort(41001);
      await client.isRunning();
      writePort(41002);
      await client.isRunning();
    } finally {
      globalThis.fetch = realFetch;
      process.env.HOME = savedHome;
      cleanupTmpHome(home);
    }
    expect(seen).toEqual([
      'http://127.0.0.1:41001/api/sessions',
      'http://127.0.0.1:41002/api/sessions',
    ]);
  });

  test('a base URL function is read on every request', async () => {
    const urls: string[] = [];
    let port = 1;
    const client = new WebttyClient(
      () => localBaseUrl(port++),
      async (url) => {
        urls.push(url);
        return json([]);
      },
    );
    await client.isRunning();
    await client.isRunning();
    expect(urls).toEqual(['http://127.0.0.1:1/api/sessions', 'http://127.0.0.1:2/api/sessions']);
  });

  test('the default fetch is the global one, looked up per call', async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        seen.push(String(url));
        return json([]);
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      expect(await new WebttyClient(FAKE_BASE_URL).isRunning()).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen).toEqual([`${FAKE_BASE_URL}/api/sessions`]);
  });
});

describe('isRunning', () => {
  const cases: Array<[string, Responder, boolean]> = [
    ['a JSON array', () => json([]), true],
    ['a JSON object', () => json({}), false],
    ['a non-2xx status', () => json([], 500), false],
    ['a body that is not JSON', () => new Response('<html>'), false],
    ['a refused connection', refused, false],
  ];
  for (const [name, respond, expected] of cases) {
    test(`${name} → ${expected}`, async () => {
      const { client } = clientFor({ 'GET /api/sessions': respond });
      expect(await client.isRunning()).toBe(expected);
    });
  }
});

describe('listSessions', () => {
  test('returns the sessions', async () => {
    const sessions = [{ id: 'main', connected: true, createdAt: 1 }];
    const { client } = clientFor({ 'GET /api/sessions': () => json(sessions) });
    expect(await client.listSessions()).toEqual(sessions);
  });

  test('throws ServerUnreachableError, keeping the cause, when the server is down', async () => {
    const { client } = clientFor({ 'GET /api/sessions': refused });
    const error = await client.listSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerUnreachableError);
    expect((error as Error).message).toBe('fetch failed');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  test('a body that is not JSON is not mistaken for an unreachable server', async () => {
    const { client } = clientFor({ 'GET /api/sessions': () => new Response('<html>') });
    const error = await client.listSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyntaxError);
  });

  test('a non-Error rejection still becomes ServerUnreachableError', async () => {
    const client = new WebttyClient(FAKE_BASE_URL, () => Promise.reject('down'));
    const error = await client.listSessions().catch((e: unknown) => e);
    expect((error as Error).message).toBe('down');
  });
});

describe('ensureSession', () => {
  test('returns an existing session without creating one', async () => {
    const { client, requests } = clientFor({ 'GET /api/sessions/a%20b': () => json({}) });
    expect(await client.ensureSession('a b')).toEqual({ id: 'a b' });
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  test('creates a missing session with its baseDir and returns the id the server gave', async () => {
    const { client, requests } = clientFor({
      'GET /api/sessions/x': () => json({ error: 'not found' }, 404),
      'POST /api/sessions': () => json({ id: 'x' }, 201),
    });
    expect(await client.ensureSession('x', '/work')).toEqual({ id: 'x' });
    expect(requests[1]).toEqual({
      method: 'POST',
      path: '/api/sessions',
      body: { id: 'x', baseDir: '/work' },
    });
  });

  test('sends no baseDir key when none is given', async () => {
    const { client, requests } = clientFor({
      'GET /api/sessions/x': () => json({}, 404),
      'POST /api/sessions': () => json({ id: 'x' }, 201),
    });
    await client.ensureSession('x');
    expect(requests[1]?.body).toEqual({ id: 'x' });
  });

  test("returns the server's error, or a status message without one", async () => {
    const withError = clientFor({
      'GET /api/sessions/x': () => json({}, 404),
      'POST /api/sessions': () => json({ error: 'invalid id' }, 400),
    });
    expect(await withError.client.ensureSession('x')).toEqual({ error: 'invalid id' });
    const without = clientFor({
      'GET /api/sessions/x': () => json({}, 404),
      'POST /api/sessions': () => json({}, 500),
    });
    expect(await without.client.ensureSession('x')).toEqual({
      error: 'failed to create session (500)',
    });
  });
});

describe('removeSession, renameSession and stop', () => {
  test('removeSession returns the status and X-Sessions-Remaining', async () => {
    const { client, requests } = clientFor({
      'DELETE /api/sessions/x': () =>
        new Response(null, { status: 204, headers: { 'X-Sessions-Remaining': '0' } }),
    });
    expect(await client.removeSession('x')).toEqual({ status: 204, sessionsRemaining: '0' });
    expect(requests).toHaveLength(1);
  });

  test('renameSession PATCHes the new id and reads the error lazily', async () => {
    const { client, requests } = clientFor({
      'PATCH /api/sessions/x': () => json({ error: 'id taken' }, 409),
    });
    const result = await client.renameSession('x', 'y');
    expect(requests[0]?.body).toEqual({ id: 'y' });
    expect([result.status, result.ok]).toEqual([409, false]);
    expect(await result.error()).toBe('id taken');
  });

  test('stop POSTs /api/server/stop and reports whether it was accepted', async () => {
    const accepted = clientFor({ 'POST /api/server/stop': () => new Response('stopping') });
    expect(await accepted.client.stop()).toBe(true);
    const rejected = clientFor({
      'POST /api/server/stop': () => new Response('no', { status: 500 }),
    });
    expect(await rejected.client.stop()).toBe(false);
  });
});

describe('execute', () => {
  const route = 'POST /s/my%20s/execute';

  test('POSTs the command and yields each NDJSON message across chunk splits', async () => {
    const text = lines(
      { stream: 'stdout', data: 'a' },
      { stream: 'stderr', data: 'b' },
      { exit: 0 },
    );
    const { client, requests } = clientFor({
      [route]: () => ndjson(text.slice(0, 7), text.slice(7, 30), text.slice(30)),
    });
    const res = await client.execute('my s', 'ls', ['-l']);
    expect(requests[0]?.body).toEqual({ cmd: 'ls', args: ['-l'] });
    expect([res.status, res.ok]).toEqual([200, true]);
    expect(await collect(res.messages)).toEqual([
      { stream: 'stdout', data: 'a' },
      { stream: 'stderr', data: 'b' },
      { exit: 0 },
    ]);
  });

  test('a stream without an exit message just ends', async () => {
    const { client } = clientFor({ [route]: () => ndjson(lines({ stream: 'stdout', data: 'x' })) });
    const res = await client.execute('my s', 'ls', []);
    expect(await collect(res.messages)).toEqual([{ stream: 'stdout', data: 'x' }]);
  });

  test('an unterminated last line is not yielded', async () => {
    const { client } = clientFor({ [route]: () => ndjson('{"exit":0}') });
    const res = await client.execute('my s', 'ls', []);
    expect(await collect(res.messages)).toEqual([]);
  });

  test('a line that is not JSON throws while iterating', async () => {
    const { client } = clientFor({ [route]: () => ndjson('not json\n') });
    const res = await client.execute('my s', 'ls', []);
    await expect(collect(res.messages)).rejects.toThrow(SyntaxError);
  });

  test('a connection that closes mid-stream rejects the iteration', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) controller.error(new Error('socket hang up'));
        else controller.enqueue(new TextEncoder().encode(lines({ stream: 'stdout', data: 'x' })));
        sent = true;
      },
    });
    const { client } = clientFor({ [route]: () => new Response(body) });
    const res = await client.execute('my s', 'ls', []);
    const seen: unknown[] = [];
    const error = await (async () => {
      for await (const message of res.messages ?? []) seen.push(message);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([{ stream: 'stdout', data: 'x' }]);
    expect((error as Error).message).toBe('socket hang up');
  });

  test('a response without a body has no messages', async () => {
    const { client } = clientFor({ [route]: () => new Response(null, { status: 404 }) });
    const res = await client.execute('my s', 'ls', []);
    expect(res).toEqual({ status: 404, ok: false, messages: null });
  });
});

describe('openPty', () => {
  test('opens the 80x24 PTY socket on the ws URL, closes it with 1000 and resolves', async () => {
    const { client, sockets } = clientFor({}, 'open');
    await client.openPty('a b');
    expect(sockets.urls).toEqual(['ws://127.0.0.1:7681/ws/a%20b/pty?cols=80&rows=24']);
    expect(sockets.closeCodes).toEqual([1000]);
  });

  test('rejects when the socket errors', async () => {
    const { client } = clientFor({}, 'error');
    await expect(client.openPty('x')).rejects.toThrow('failed to connect to PTY');
  });

  test('rejects with the close code when the socket closes before opening', async () => {
    const { client } = clientFor({}, 'close-without-open');
    await expect(client.openPty('x')).rejects.toThrow('failed to start PTY (code 1006)');
  });

  test('the default socket factory is the global WebSocket', async () => {
    const realWebSocket = globalThis.WebSocket;
    const urls: string[] = [];
    class RecordingSocket {
      onopen: ((event: Event) => void) | null = null;
      constructor(url: string) {
        urls.push(url);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }
      close() {}
    }
    globalThis.WebSocket = RecordingSocket as unknown as typeof WebSocket;
    try {
      await new WebttyClient(FAKE_BASE_URL).openPty('x');
    } finally {
      globalThis.WebSocket = realWebSocket;
    }
    expect(urls).toEqual(['ws://127.0.0.1:7681/ws/x/pty?cols=80&rows=24']);
  });
});
