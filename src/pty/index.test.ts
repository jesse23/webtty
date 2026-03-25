import { describe, expect, test } from 'bun:test';
import { spawnForSession } from './index';

describe('spawnForSession', () => {
  test('returns a PtyProcess with the expected interface', () => {
    const pty = spawnForSession(
      80,
      24,
      process.env.SHELL ?? '/bin/sh',
      'xterm-256color',
      'truecolor',
    );

    expect(typeof pty.onData).toBe('function');
    expect(typeof pty.onExit).toBe('function');
    expect(typeof pty.write).toBe('function');
    expect(typeof pty.resize).toBe('function');
    expect(typeof pty.kill).toBe('function');

    pty.resize(120, 40);
    pty.kill();
  });

  test('spawned process can receive data', async () => {
    const pty = spawnForSession(
      80,
      24,
      process.env.SHELL ?? '/bin/sh',
      'xterm-256color',
      'truecolor',
    );
    const received: string[] = [];
    pty.onData((data) => received.push(data));

    await Bun.sleep(800);
    pty.write('echo hello-pty\n');
    await Bun.sleep(800);
    pty.write('exit\n');

    await new Promise<void>((resolve) => pty.onExit(() => resolve()));
    expect(received.join('')).toContain('hello-pty');
  });
});
