// Golden tests for the streaming routes: `POST /s/:id/publish` (NDJSON in, broadcast to the
// event subscribers) and `POST /s/:id/execute` (a child process streamed out as NDJSON), pinned
// before the routes move into the ordered route table (ADR 062, ADR 064).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { FakeSocket } from '../test-support/fake-socket';
import {
  BAD_REQUEST,
  NDJSON,
  NOT_FOUND,
  plain,
  RouteHarness,
  until,
} from '../test-support/route-harness';

const h = new RouteHarness();
const { call, post, running, idle, postStream } = h;

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => h.reset());

describe('routes golden — POST /s/:id/publish', () => {
  test('refuses bad ids, wrong content types, unknown sessions and stopped shells', async () => {
    idle('idle');
    running('live');
    expect(await post('/s/%E0%A4%A/publish', '{}')).toEqual(BAD_REQUEST);
    expect(await post('/s/live/publish', '{}', 'text/plain')).toEqual(BAD_REQUEST);
    expect(await call('POST', '/s/live/publish', { body: '{}' })).toEqual(BAD_REQUEST);
    expect(await post('/s/nope/publish', '{}')).toEqual(NOT_FOUND);
    expect(await post('/s/idle/publish', '{}')).toEqual({
      status: 409,
      headers: plain(15),
      body: 'PTY not running',
    });
  });

  test('broadcasts each valid NDJSON line, CRLF trimmed, a partial last line included', async () => {
    const s = running('live');
    const sub = new FakeSocket();
    s.subscribers.add(sub);
    const body = '{"a":1}\r\n\n not json\n{"b":2}\n\r\n{"c":3}\r';
    expect(await post('/s/live/publish', body, 'application/json; charset=utf-8')).toEqual({
      status: 204,
      headers: plain(0),
      body: '',
    });
    expect(sub.sent).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('an invalid partial last line is skipped and a line over 64 KB is dropped', async () => {
    const s = running('live');
    const sub = new FakeSocket();
    s.subscribers.add(sub);
    expect((await post('/s/live/publish', '{"a":1}\n{"b":')).status).toBe(204);
    expect((await post('/s/live/publish', `{"big":"${'x'.repeat(70 * 1024)}"}`)).status).toBe(204);
    expect(sub.sent).toEqual(['{"a":1}']);
  });

  test('lines are broadcast as they arrive and 204 is sent only after the body ends', async () => {
    const s = running('live');
    const sub = new FakeSocket();
    s.subscribers.add(sub);
    const { controller: push, response } = postStream('/s/live/publish');
    let answered = false;
    const pending = response.then((res) => {
      answered = true;
      return res;
    });
    push.enqueue(new TextEncoder().encode('{"first":1}\n{"sec'));
    await until(() => sub.sent.length === 1);
    expect(answered).toBe(false);
    push.enqueue(new TextEncoder().encode('ond":2}'));
    push.close();
    expect((await pending).status).toBe(204);
    expect(sub.sent).toEqual(['{"first":1}', '{"second":2}']);
  });
});

describe('routes golden — POST /s/:id/execute', () => {
  const run = (body: unknown) => post('/s/live/execute', body);
  const script = (code: string, stdin?: string) => ({
    cmd: process.execPath,
    args: ['-e', code],
    ...(stdin === undefined ? {} : { stdin }),
  });

  test('refuses bad ids, wrong content types, unknown sessions, stopped shells and bad bodies', async () => {
    idle('idle');
    running('live');
    const invalidBody = { status: 400, headers: plain(12), body: 'invalid body' };
    expect(await post('/s/%E0%A4%A/execute', '{}')).toEqual(BAD_REQUEST);
    expect(await post('/s/live/execute', '{}', 'text/plain')).toEqual(BAD_REQUEST);
    expect(await post('/s/nope/execute', '{}')).toEqual(NOT_FOUND);
    expect(await post('/s/idle/execute', '{}')).toEqual({
      status: 409,
      headers: plain(15),
      body: 'PTY not running',
    });
    expect(await run('{bad')).toEqual({ status: 400, headers: plain(12), body: 'invalid JSON' });
    for (const body of [
      {},
      { cmd: '' },
      { cmd: 1, args: [] },
      { cmd: 'ls' },
      { cmd: 'ls', args: [1] },
    ]) {
      expect(await run(body)).toEqual(invalidBody);
    }
  });

  test('a body over 64 KB drops the connection', async () => {
    running('live');
    await expect(run('x'.repeat(70 * 1024))).rejects.toThrow();
  });

  test('streams stdout as NDJSON then the exit code, feeding stdin', async () => {
    running('live');
    const code = 'process.stdout.write(require("fs").readFileSync(0,"utf8").toUpperCase())';
    expect(await run(script(code, 'hi'))).toEqual({
      status: 200,
      headers: NDJSON,
      body: '{"stream":"stdout","data":"HI"}\n{"exit":0}\n',
    });
  });

  test('streams stderr and a non-zero exit code', async () => {
    running('live');
    expect(await run(script('process.stderr.write("oops");process.exit(3)'))).toEqual({
      status: 200,
      headers: NDJSON,
      body: '{"stream":"stderr","data":"oops"}\n{"exit":3}\n',
    });
  });

  test('runs in the session baseDir with the config env and without the server PORT', async () => {
    h.writeConfig({ env: { GOLDEN: 'yes' } });
    running('live');
    const code = 'process.stdout.write([process.cwd(),process.env.GOLDEN].join("|"))';
    const reply = await run(script(code));
    const cwd = fs.realpathSync(h.tmpHome);
    expect(reply.body).toBe(
      `${JSON.stringify({ stream: 'stdout', data: `${cwd}|yes` })}\n{"exit":0}\n`,
    );
  });

  test('a missing command streams its error and exit 1 with the errno code', async () => {
    running('live');
    const reply = await run({ cmd: 'webtty-golden-no-such-command', args: [] });
    expect(reply.status).toBe(200);
    expect(reply.headers).toEqual(NDJSON);
    const [first, second, ...rest] = reply.body.split('\n');
    const { error } = JSON.parse(second) as { error: string };
    expect(JSON.parse(first)).toEqual({ stream: 'stderr', data: `${error}\n` });
    expect(JSON.parse(second)).toEqual({ exit: 1, error, code: 'ENOENT' });
    expect(rest).toEqual(['']);
  });

  test('a spawn that throws is 500 "spawn error: …"', async () => {
    running('live');
    const reply = await run({ cmd: 'a\0b', args: [] });
    expect(reply.status).toBe(500);
    expect(reply.headers).toEqual(plain(reply.body.length));
    expect(reply.body.startsWith('spawn error: TypeError')).toBe(true);
  });
});
