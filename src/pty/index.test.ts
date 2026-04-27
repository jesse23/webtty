import { describe, expect, test } from 'bun:test';
import { spawnForSession } from './index';

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
const isBunOnWindows =
  process.platform === 'win32' &&
  typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';

describe('spawnForSession', () => {
  test('returns a PtyProcess with the expected interface', () => {
    const pty = spawnForSession(80, 24, TEST_SHELL, 'xterm-256color', 'truecolor');

    expect(typeof pty.onData).toBe('function');
    expect(typeof pty.onExit).toBe('function');
    expect(typeof pty.write).toBe('function');
    expect(typeof pty.resize).toBe('function');
    expect(typeof pty.kill).toBe('function');

    pty.resize(120, 40);
    pty.kill();
  });

  test.skipIf(isBunOnWindows)('spawned process can receive data', async () => {
    const pty = spawnForSession(80, 24, TEST_SHELL, 'xterm-256color', 'truecolor');
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
});
