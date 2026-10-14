// Golden tests for the API routes: server stop and status, /api/config and the sessions
// CRUD, each reply's status, headers and body pinned as literals before the routes move into
// the ordered route table (ADR 062, ADR 064). Pages and assets are in routes-pages-golden.test.ts,
// the NDJSON routes in routes-streams-golden.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { DEFAULT_THEME } from '../config';
import { FakeSocket } from '../test-support/fake-socket';
import {
  BAD_REQUEST,
  json,
  NOT_FOUND,
  plain,
  type Reply,
  RouteHarness,
  sessionBody,
} from '../test-support/route-harness';
import { getVersion } from '../version';
import { readJson } from './routes';
import type { Session } from './sessions/session';

const h = new RouteHarness();
const { call, post, running, idle } = h;

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => h.reset());

describe('routes golden — server', () => {
  test('OPTIONS on any path is 204 with CORS and no body', async () => {
    for (const url of ['/', '/api/sessions', '/nowhere']) {
      expect(await call('OPTIONS', url)).toEqual({ status: 204, headers: plain(0), body: '' });
    }
  });

  test('POST /api/server/stop answers "stopping" and then calls onStop once', async () => {
    expect(await call('POST', '/api/server/stop')).toEqual({
      status: 200,
      headers: { ...plain(8), 'content-type': 'text/plain' },
      body: 'stopping',
    });
    expect(h.stops).toBe(1);
  });

  test('GET /api/server/status reports the package version', async () => {
    const body = JSON.stringify({ version: getVersion() });
    expect(await call('GET', '/api/server/status')).toEqual({
      status: 200,
      headers: json(body),
      body,
    });
  });

  test('stop and status answer only their own method', async () => {
    expect(await call('GET', '/api/server/stop')).toEqual(NOT_FOUND);
    expect(await call('POST', '/api/server/status')).toEqual(NOT_FOUND);
    expect(h.stops).toBe(0);
  });
});

describe('routes golden — /api/config', () => {
  test('sends the client keys in order with the defaults, legacy scrollback included', async () => {
    const body = JSON.stringify({
      cols: 80,
      rows: 24,
      fontSize: 13,
      fontFamily: "Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'",
      cursorStyle: 'bar',
      cursorStyleBlink: true,
      scrollback: 256 * 1024,
      scrollbackLines: 10000,
      theme: DEFAULT_THEME,
      copyOnSelect: true,
      rightClickBehavior: 'contextMenu',
      clipboardWrite: true,
      bellTitle: true,
      desktopNotifications: true,
      mouseScrollSpeed: 1,
      padding: 0,
      keyboardBindings: [],
    });
    expect(await call('GET', '/api/config')).toEqual({ status: 200, headers: json(body), body });
  });

  test('reads the config file per request and never sends server-side keys', async () => {
    h.writeConfig({ fontSize: 20, shell: '/bin/zsh', host: '0.0.0.0', env: { A: '1' } });
    const reply = await call('GET', '/api/config');
    const config = JSON.parse(reply.body) as Record<string, unknown>;
    expect(config.fontSize).toBe(20);
    expect(Object.keys(config)).not.toContain('shell');
    expect(Object.keys(config)).not.toContain('host');
    expect(Object.keys(config)).not.toContain('env');
    expect(Object.keys(config)).not.toContain('port');
  });
});

describe('routes golden — /api/sessions', () => {
  test('GET lists the sessions in creation order', async () => {
    expect(await call('GET', '/api/sessions')).toEqual({
      status: 200,
      headers: json('[]'),
      body: '[]',
    });
    const a = idle('a');
    const b = running('b', 77);
    const body = `[${sessionBody(a)},${sessionBody(b)}]`;
    expect(await call('GET', '/api/sessions')).toEqual({ status: 200, headers: json(body), body });
  });

  test('POST creates a session under the given id and baseDir', async () => {
    const reply = await post('/api/sessions', { id: 'work', baseDir: h.tmpHome });
    const created = h.store.get('work') as Session;
    const body = sessionBody(created);
    expect(reply).toEqual({ status: 201, headers: json(body), body });
    expect(created.baseDir).toBe(h.tmpHome);
  });

  test('POST without a body generates an id and uses the home directory', async () => {
    const reply = await call('POST', '/api/sessions');
    expect(reply.status).toBe(201);
    const { id } = JSON.parse(reply.body) as { id: string };
    expect(h.store.has(id)).toBe(true);
    expect(reply.body).toBe(sessionBody(h.store.get(id) as Session));
  });

  test('POST rejects bad bodies with the old status and text', async () => {
    fs.writeFileSync(path.join(h.tmpHome, 'a-file'), '');
    const missing = path.join(h.tmpHome, 'missing');
    const file = path.join(h.tmpHome, 'a-file');
    const cases: [unknown, number, string][] = [
      ['{nope', 400, 'invalid JSON'],
      [{ id: 'bad id!' }, 400, JSON.stringify({ error: 'invalid id: bad id!' })],
      [{ id: 'x', baseDir: 'rel/dir' }, 400, '{"error":"baseDir must be an absolute path"}'],
      [
        { id: 'x', baseDir: missing },
        400,
        JSON.stringify({ error: `baseDir does not exist: ${missing}` }),
      ],
      [
        { id: 'x', baseDir: file },
        400,
        JSON.stringify({ error: `baseDir is not a directory: ${file}` }),
      ],
    ];
    for (const [body, status, text] of cases) {
      const headers = text.startsWith('{') ? json(text) : plain(text.length);
      expect(await post('/api/sessions', body)).toEqual({ status, headers, body: text });
    }
    expect(h.store.size).toBe(0);
  });

  test('POST answers 409 for an id that exists', async () => {
    idle('dup');
    const body = JSON.stringify({ error: 'session already exists: dup' });
    expect(await post('/api/sessions', { id: 'dup' })).toEqual({
      status: 409,
      headers: json(body),
      body,
    });
  });

  test('POST over 64 KB drops the connection and creates nothing (the 413 never reaches the wire)', async () => {
    await expect(post('/api/sessions', 'x'.repeat(70 * 1024))).rejects.toThrow();
    expect(h.store.size).toBe(0);
  });

  test('PUT and DELETE on the collection fall through to 404', async () => {
    expect(await call('PUT', '/api/sessions')).toEqual(NOT_FOUND);
    expect(await call('DELETE', '/api/sessions')).toEqual(NOT_FOUND);
  });
});

describe('routes golden — /api/sessions/:id', () => {
  test('GET returns the session, decoding the id, or 404', async () => {
    const s = running('a.b', 99);
    const body = sessionBody(s);
    expect(await call('GET', '/api/sessions/a.b')).toEqual({
      status: 200,
      headers: json(body),
      body,
    });
    expect(await call('GET', '/api/sessions/a%2Eb')).toEqual({
      status: 200,
      headers: json(body),
      body,
    });
    expect(await call('GET', '/api/sessions/nope')).toEqual(NOT_FOUND);
  });

  test('an undecodable id is 400 Bad Request for every method', async () => {
    for (const method of ['GET', 'PATCH', 'DELETE', 'PUT']) {
      expect(await call(method, '/api/sessions/%E0%A4%A')).toEqual(BAD_REQUEST);
    }
  });

  test('PATCH renames the session and answers with its new JSON', async () => {
    const s = idle('old');
    h.store.markUsed('old');
    const reply = await call('PATCH', '/api/sessions/old', { body: '{"id":"new"}' });
    const body = sessionBody(s);
    expect(reply).toEqual({ status: 200, headers: json(body), body });
    expect(s.id).toBe('new');
    expect(h.store.has('old')).toBe(false);
    expect(h.store.lastUsedId).toBe('new');
  });

  test('PATCH errors: invalid JSON, 404, missing id, invalid id, 409', async () => {
    idle('a');
    idle('b');
    const invalidId = JSON.stringify({ error: 'invalid id: no way' });
    const conflict = JSON.stringify({ error: 'session already exists: b' });
    const cases: [string, string, Reply][] = [
      ['a', '{bad', { status: 400, headers: plain(12), body: 'invalid JSON' }],
      ['zzz', '{"id":"c"}', NOT_FOUND],
      ['a', '{}', { status: 400, headers: plain(10), body: 'missing id' }],
      ['a', '{"id":"no way"}', { status: 400, headers: json(invalidId), body: invalidId }],
      ['a', '{"id":"b"}', { status: 409, headers: json(conflict), body: conflict }],
    ];
    for (const [id, body, expected] of cases) {
      expect(await call('PATCH', `/api/sessions/${id}`, { body })).toEqual(expected);
    }
    expect(h.store.list().map((s) => s.id)).toEqual(['a', 'b']);
  });

  test('DELETE closes the session with 4001, answers 204 and X-Sessions-Remaining', async () => {
    const log: string[] = [];
    const s = running('gone', 4242, log);
    const sub = new FakeSocket();
    s.subscribers.add(sub);
    idle('kept');
    expect(await call('DELETE', '/api/sessions/gone')).toEqual({
      status: 204,
      headers: { ...plain(0), 'x-sessions-remaining': '1' },
      body: '',
    });
    expect(sub.closed).toEqual({ code: 4001, reason: 'session deleted' });
    expect(log).toEqual(['pty.kill']);
    expect(h.store.has('gone')).toBe(false);
    expect(await call('DELETE', '/api/sessions/gone')).toEqual(NOT_FOUND);
  });

  test('POST and PUT on a session and deeper paths are 404', async () => {
    idle('a');
    expect(await call('POST', '/api/sessions/a')).toEqual(NOT_FOUND);
    expect(await call('PUT', '/api/sessions/a')).toEqual(NOT_FOUND);
    expect(await call('GET', '/api/sessions/a/b')).toEqual(NOT_FOUND);
  });
});

describe('readJson', () => {
  /** A request whose body is `chunks`, with no socket behind it. */
  function request(...chunks: string[]): http.IncomingMessage {
    const req = new http.IncomingMessage(new Socket());
    for (const c of chunks) req.push(c);
    req.push(null);
    return req;
  }

  test('parses the body, and an empty body is {}', async () => {
    expect(await readJson(request('{"a":', '1}'))).toEqual({ a: 1 });
    expect(await readJson(request())).toEqual({});
  });

  test('rejects invalid JSON, and a body over 64 KB with status 413', async () => {
    await expect(readJson(request('{nope'))).rejects.toThrow('invalid JSON');
    await expect(readJson(request('x'.repeat(64 * 1024 + 1)))).rejects.toMatchObject({
      message: 'payload too large',
      status: 413,
    });
  });
});
