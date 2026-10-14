// Tests for the PTY facade: which backend each runtime and platform picks, and spawnPty
// returning a working PtyProcess (ADR 062).
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bunTerminalAvailable, isWindows, type RuntimeEnv, runningUnderBun } from '../runtime';
import { type PtySpawnOptions, selectBackend, spawnPty } from './index';

function waitForData(received: string[], content: string, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      if (received.join('').includes(content)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timeout waiting for: ${content}`));
      setTimeout(check, 50);
    };
    check();
  });
}

// On Windows use COMSPEC (the full path to cmd.exe) to bypass any PATH shims
// that shell enhancers like clink install (clink wraps cmd.exe with a bat launcher).
const TEST_SHELL = process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';

// On Windows, Bun's ConPTY/net.Socket integration has a known issue where the
// pipe closes after the initial banner is written, causing ERR_SOCKET_CLOSED on
// the first PTY write. The server always runs under Node on Windows (see http.ts),
// so skip the interactive data test under Bun on Windows — it passes in CI (Linux)
// and under Node on Windows.
const isBunOnWindows = isWindows() && runningUnderBun();

/** Spawn options for the test shell at 80x24 in the current directory. */
function options(): PtySpawnOptions {
  return {
    shell: TEST_SHELL,
    cols: 80,
    rows: 24,
    term: 'xterm-256color',
    colorTerm: 'truecolor',
    cwd: process.cwd(),
    env: {},
  };
}

/** A runtime snapshot with only the fields selectBackend reads set. */
const runtime = (platform: string, bunVersion: string | undefined): RuntimeEnv => ({
  platform,
  execPath: '/usr/bin/x',
  bunVersion,
  bunGlobal: undefined,
});

describe('selectBackend', () => {
  test.each([
    ['Bun on macOS', 'Bun.Terminal', runtime('darwin', '1.3.0')],
    ['Bun on Linux', 'Bun.Terminal', runtime('linux', '1.3.0')],
    ['Bun on Windows', 'node-pty', runtime('win32', '1.3.0')],
    ['Node on macOS', 'node-pty', runtime('darwin', undefined)],
    ['Node on Linux', 'node-pty', runtime('linux', undefined)],
    ['Node on Windows', 'node-pty', runtime('win32', undefined)],
  ] as const)('%s uses %s', (_name, expected, env) => {
    expect(selectBackend(env)).toBe(expected);
  });

  test('defaults to the live process', () => {
    expect(selectBackend()).toBe(bunTerminalAvailable() ? 'Bun.Terminal' : 'node-pty');
  });
});

describe('spawnPty', () => {
  test('returns a PtyProcess with the expected interface', () => {
    const pty = spawnPty(options());

    expect(typeof pty.onData).toBe('function');
    expect(typeof pty.onExit).toBe('function');
    expect(typeof pty.write).toBe('function');
    expect(typeof pty.resize).toBe('function');
    expect(typeof pty.kill).toBe('function');

    pty.resize(120, 40);
    pty.kill();
  });

  test.skipIf(isBunOnWindows)('spawned process can receive data', async () => {
    const pty = spawnPty(options());
    const received: string[] = [];
    pty.onData((data) => received.push(data));

    const echoReady = process.platform === 'win32' ? 'echo __ready__\r\n' : 'echo __ready__\n';
    const echoHello = process.platform === 'win32' ? 'echo hello-pty\r\n' : 'echo hello-pty\n';
    const exitCmd = process.platform === 'win32' ? 'exit\r\n' : 'exit\n';

    pty.write(echoReady);
    await waitForData(received, '__ready__');
    pty.write(echoHello);
    await waitForData(received, 'hello-pty');
    pty.write(exitCmd);

    await new Promise<void>((resolve) => pty.onExit(() => resolve()));
    expect(received.join('')).toContain('hello-pty');
  });

  test.skipIf(process.platform === 'win32')(
    'multi-byte characters split across reads arrive intact',
    async () => {
      // `cat` writes in fixed-size blocks, so 3-byte `─` characters after a 1-byte
      // prefix straddle block (and read) boundaries.
      const file = path.join(os.tmpdir(), `webtty-pty-mb-${process.pid}.txt`);
      fs.writeFileSync(file, `x${'─'.repeat(100_000)}\n`);
      const pty = spawnPty(options());
      const received: string[] = [];
      pty.onData((d) => received.push(d));
      pty.write(`cat '${file}'; echo DONE-$((40+2))\n`);
      try {
        await waitForData(received, 'DONE-42', 15000);
      } finally {
        pty.kill();
        fs.rmSync(file, { force: true });
      }
      const out = received.join('');
      expect(out.split('\uFFFD').length - 1).toBe(0);
      expect(out.split('─').length - 1).toBe(100_000);
    },
    20000,
  );
});
