// Tests for run-command with a fake spawn: the NDJSON lines for stdout, stderr and exit, a
// synchronous and an asynchronous spawn failure, stdin, the kill on client close, env and cwd.
import { describe, expect, spyOn, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import http from 'node:http';
import { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { recordResponse } from '../../test-support/response-recorder';
import { type RunCommandOptions, runCommand, type SpawnFn } from './run-command';

const NDJSON_HEAD = [
  'writeHead',
  200,
  { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' },
];

/** A ChildProcess with in-memory pipes; nothing is spawned. */
function fakeChild() {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (c: Buffer) => written.push(c.toString()));
  // Bun's ChildProcess exposes the pipes as getters, so they are defined rather than assigned.
  for (const [name, stream] of [
    ['stdin', stdin],
    ['stdout', new PassThrough()],
    ['stderr', new PassThrough()],
  ] as const) {
    Object.defineProperty(child, name, { value: stream });
  }
  const kill = spyOn(child, 'kill').mockImplementation(() => true);
  return { child, stdin, written, kill };
}

/** Runs `options` against a fake child and records the reply, the spawn calls and writes. */
function run(options: Partial<RunCommandOptions> = {}, spawnImpl?: SpawnFn) {
  const fake = fakeChild();
  const spawned: Parameters<SpawnFn>[] = [];
  const spawn: SpawnFn =
    spawnImpl ??
    ((...a) => {
      spawned.push(a);
      return fake.child;
    });
  const req = new http.IncomingMessage(new Socket());
  const { res, calls } = recordResponse();
  spyOn(res, 'write').mockImplementation((chunk: unknown) => {
    calls.push(['write', chunk]);
    return true;
  });
  const full: RunCommandOptions = {
    cmd: 'echo',
    args: ['hi'],
    cwd: '/work',
    env: () => ({ A: '1' }),
    ...options,
  };
  runCommand(req, res, full, spawn);
  return { ...fake, req, res, calls, spawned };
}

describe('runCommand', () => {
  test('spawns with the command, args, env, cwd and windowsHide', () => {
    const { spawned } = run({ cmd: 'ls', args: ['-l', 'x'], cwd: '/tmp/x' });
    expect(spawned).toEqual([
      ['ls', ['-l', 'x'], { env: { A: '1' }, cwd: '/tmp/x', windowsHide: true }],
    ]);
  });

  test('streams stdout and stderr chunks, then the exit code', () => {
    const { child, calls } = run();
    (child.stdout as PassThrough).emit('data', Buffer.from('out'));
    (child.stderr as PassThrough).emit('data', Buffer.from('err'));
    child.emit('close', 3);
    expect(calls).toEqual([
      NDJSON_HEAD,
      ['write', '{"stream":"stdout","data":"out"}\n'],
      ['write', '{"stream":"stderr","data":"err"}\n'],
      ['write', '{"exit":3}\n'],
      ['end'],
    ]);
  });

  test('a null exit code (killed by a signal) is reported as 1', () => {
    const { child, calls } = run();
    child.emit('close', null);
    expect(calls.slice(1)).toEqual([['write', '{"exit":1}\n'], ['end']]);
  });

  test('writes stdin when given and closes it either way', async () => {
    const withInput = run({ stdin: 'abc' });
    const without = run();
    await Bun.sleep(0);
    expect(withInput.written).toEqual(['abc']);
    expect(withInput.stdin.writableEnded).toBe(true);
    expect(without.written).toEqual([]);
    expect(without.stdin.writableEnded).toBe(true);
  });

  test('an asynchronous spawn error ends the stream with stderr and exit 1, once', () => {
    const { child, calls } = run();
    child.emit('error', Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }));
    child.emit('close', 0);
    child.emit('error', new Error('again'));
    expect(calls).toEqual([
      NDJSON_HEAD,
      ['write', '{"stream":"stderr","data":"spawn nope ENOENT\\n"}\n'],
      ['write', '{"exit":1,"error":"spawn nope ENOENT","code":"ENOENT"}\n'],
      ['end'],
    ]);
  });

  test('an error without a code leaves `code` out', () => {
    const { child, calls } = run();
    child.emit('error', new Error('boom'));
    expect(calls[2]).toEqual(['write', '{"exit":1,"error":"boom"}\n']);
  });

  test('a synchronous spawn throw is a 500 with no stream', () => {
    const { calls } = run({}, () => {
      throw new Error('bad');
    });
    expect(calls).toEqual([
      ['writeHead', 500],
      ['end', 'spawn error: Error: bad'],
    ]);
  });

  test('an env that throws is answered like a spawn throw', () => {
    const { calls, spawned } = run({
      env: () => {
        throw new Error('config');
      },
    });
    expect(spawned).toEqual([]);
    expect(calls).toEqual([
      ['writeHead', 500],
      ['end', 'spawn error: Error: config'],
    ]);
  });

  test('the child is killed if the client goes away before it exits, not after', () => {
    const early = run();
    early.req.emit('close');
    expect(early.kill).toHaveBeenCalledTimes(1);

    const late = run();
    late.child.emit('close', 0);
    late.req.emit('close');
    expect(late.kill).not.toHaveBeenCalled();
  });
});
