// Subprocess smoke tests for the server entry, src/server/index.ts: the parts that only a real
// process shows, namely the PORT variable, its removal from the shell's environment, the
// localhost bind and the exit on stop. Everything else runs in-process (ADR 062, ADR 064).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { isWindows, runningUnderBun } from '../runtime';
import {
  cleanupTmpHome,
  getFreePort,
  makeTmpHome,
  waitForServer,
} from '../test-support/server-harness';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// On Windows, Bun's ConPTY/net.Socket integration doesn't support the pipe handles node-pty
// requires, so the server runs under Node from the build there.
const useNode = isWindows() && runningUnderBun();
const SERVER_EXEC = useNode ? 'node' : process.execPath;
const SERVER_ENTRY = useNode
  ? path.resolve(__dirname, '../../dist/server/index.js')
  : path.resolve(__dirname, 'index.ts');

describe('server entry', () => {
  let proc: ChildProcess;
  let port: number;
  let tmpHome: string;
  let stdout = '';
  let exitCode: Promise<number | null>;

  beforeAll(async () => {
    tmpHome = makeTmpHome('entry-test');
    // The config asks for 'localhost', which the entry binds as 127.0.0.1.
    const configDir = path.join(tmpHome, '.config', 'webtty');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ host: 'localhost' }));
    port = await getFreePort();
    proc = spawn(SERVER_EXEC, [SERVER_ENTRY], {
      env: {
        ...process.env,
        PORT: String(port),
        HOME: tmpHome,
        ...(process.platform !== 'win32' && { SHELL: '/bin/sh' }),
        ...(process.platform === 'win32' && { CLINK_NOAUTORUN: '1' }),
      },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    exitCode = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
    await waitForServer(`http://127.0.0.1:${port}`);
  });

  afterAll(() => {
    proc.kill();
    cleanupTmpHome(tmpHome);
  });

  test('listens on the PORT variable, bound to 127.0.0.1 and shown as localhost', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/server/status`);
    expect(res.status).toBe(200);
    expect(stdout).toContain(`listening on http://localhost:${port}`);
  });

  test('PORT is removed from the environment commands inherit', async () => {
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/api/sessions`, { method: 'POST', body: '{"id":"port-leak"}' });
    // /execute needs a running shell; the PTY socket spawns it.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/port-leak/pty?cols=80&rows=24`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const res = await fetch(`${base}/s/port-leak/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: process.execPath,
        args: ['-e', 'console.log(process.env.PORT ?? "")'],
      }),
    });
    ws.close();
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const stdoutLine = lines.find((l) => l.stream === 'stdout');
    expect(String(stdoutLine?.data).trim()).toBe('');
    expect(lines.at(-1)).toEqual({ exit: 0 });
  });

  test('POST /api/server/stop ends the process with exit code 0', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/server/stop`, { method: 'POST' });
    expect(await res.text()).toBe('stopping');
    expect(await exitCode).toBe(0);
  });
});
