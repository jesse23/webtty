import { describe, expect, test } from 'bun:test';
import { fakeCliDeps, RUNNING, STOPPED } from '../test-support/fake-cli-deps';
import { json, lines, ndjson, type Responder, refused } from '../test-support/scripted-fetch';
import { run } from './run';

const EXECUTE = 'POST /s/sess/execute';

describe('run — exec', () => {
  async function exec(routes: Record<string, Responder>) {
    const fake = fakeCliDeps({ ...RUNNING, ...routes });
    await run({ id: 'sess', cmd: 'echo', args: ['hi'] }, fake.deps);
    return fake;
  }

  test('streams stdout and stderr and exits with the exit code', async () => {
    const fake = await exec({
      [EXECUTE]: () =>
        ndjson(
          lines({ stream: 'stdout', data: 'hello\n' }, { stream: 'stderr', data: 'warn\n' }),
          lines({ exit: 3 }, { stream: 'stdout', data: 'after exit' }),
        ),
    });
    expect(fake.requests.at(-1)?.body).toEqual({ cmd: 'echo', args: ['hi'] });
    expect(fake.stdout).toEqual(['hello\n']);
    expect(fake.stderr).toEqual(['warn\n']);
    expect(fake.err).toEqual([]);
    expect(fake.exits).toEqual([3]);
  });

  test('an exit with an error prints it', async () => {
    const fake = await exec({
      [EXECUTE]: () => ndjson(lines({ exit: 1, error: 'command failed' })),
    });
    expect(fake.err).toEqual(['webtty: command failed']);
    expect(fake.exits).toEqual([1]);
  });

  test('a null exit code exits 1', async () => {
    const fake = await exec({ [EXECUTE]: () => ndjson(lines({ exit: null })) });
    expect(fake.exits).toEqual([1]);
  });

  test('a stream that ends without an exit message exits 1', async () => {
    const fake = await exec({
      [EXECUTE]: () => ndjson(lines({ stream: 'stdout', data: 'partial\n' }, { other: true })),
    });
    expect(fake.stdout).toEqual(['partial\n']);
    expect(fake.err).toEqual(['webtty: connection closed unexpectedly']);
    expect(fake.exits).toEqual([1]);
  });

  const refusals: Array<[number, string]> = [
    [404, 'webtty: session not found: sess'],
    [409, 'webtty: PTY not running for session: sess'],
    [500, 'webtty: run failed (500)'],
  ];
  for (const [status, message] of refusals) {
    test(`status ${status} prints "${message}" and exits 1`, async () => {
      const fake = await exec({ [EXECUTE]: () => json({}, status) });
      expect(fake.err).toEqual([message]);
      expect(fake.exits).toEqual([1]);
    });
  }

  test('a 200 without a body is a failed run', async () => {
    const fake = await exec({ [EXECUTE]: () => new Response(null, { status: 200 }) });
    expect(fake.err).toEqual(['webtty: run failed (200)']);
    expect(fake.exits).toEqual([1]);
  });

  test('a stopped server prints `server is not running` and sends no command', async () => {
    const fake = fakeCliDeps(STOPPED);
    await run({ id: 'sess', cmd: 'echo' }, fake.deps);
    expect(fake.err).toEqual(['webtty: server is not running']);
    expect(fake.exits).toEqual([1]);
    expect(fake.server).toEqual([]);
    expect(fake.requests).toHaveLength(1);
  });

  test('a server that goes away before the command prints `server is not running`', async () => {
    const fake = await exec({ [EXECUTE]: refused });
    expect(fake.err).toEqual(['webtty: server is not running']);
    expect(fake.exits).toEqual([1]);
  });

  test('an error that is not about reaching the server propagates', async () => {
    const fake = fakeCliDeps(RUNNING);
    fake.deps.client.execute = async () => {
      throw new RangeError('boom');
    };
    await expect(run({ id: 'sess', cmd: 'x' }, fake.deps)).rejects.toThrow('boom');
  });
});

describe('run — warm-up', () => {
  const existing = { 'GET /api/sessions/warm': () => json({ id: 'warm' }) };

  test('on a running server with the session: opens the PTY and prints the URL', async () => {
    const fake = fakeCliDeps({ ...RUNNING, ...existing });
    await run({ id: 'warm' }, fake.deps);
    expect(fake.sockets.urls).toEqual(['ws://127.0.0.1:7681/ws/warm/pty?cols=80&rows=24']);
    expect(fake.out).toEqual(['http://localhost:7681/s/warm']);
    expect(fake.opened).toEqual([]);
    expect(fake.server).toEqual([]);
  });

  test('starts the server and creates the session first', async () => {
    const fake = fakeCliDeps({
      ...STOPPED,
      'GET /api/sessions/warm': () => json({}, 404),
      'POST /api/sessions': () => json({ id: 'warm' }, 201),
    });
    await run({ id: 'warm' }, fake.deps);
    expect(fake.server).toEqual(['start']);
    expect(fake.requests.at(-1)?.body).toEqual({ id: 'warm' });
    expect(fake.out).toEqual(['http://localhost:7681/s/warm']);
  });

  test('a session that cannot be created prints the error and exits 1', async () => {
    const fake = fakeCliDeps({
      ...RUNNING,
      'GET /api/sessions/warm': () => json({}, 404),
      'POST /api/sessions': () => json({ error: 'bad' }, 500),
    });
    await run({ id: 'warm' }, fake.deps);
    expect(fake.err).toEqual(['webtty: bad']);
    expect(fake.exits).toEqual([1]);
    expect(fake.sockets.urls).toEqual([]);
  });

  const socketFailures: Array<['error' | 'close-without-open', string]> = [
    ['error', 'webtty: failed to start PTY: failed to connect to PTY'],
    ['close-without-open', 'webtty: failed to start PTY: failed to start PTY (code 1006)'],
  ];
  for (const [socket, message] of socketFailures) {
    test(`a socket that ${socket}s prints "${message}" and exits 1`, async () => {
      const fake = fakeCliDeps({ ...RUNNING, ...existing }, { socket });
      await run({ id: 'warm' }, fake.deps);
      expect(fake.err).toEqual([message]);
      expect(fake.exits).toEqual([1]);
      expect(fake.out).toEqual([]);
    });
  }
});
