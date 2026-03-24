import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('isServerRunning', () => {
  test('returns true when GET /api/sessions succeeds', async () => {
    globalThis.fetch = mock(
      async () => new Response('[]', { status: 200 }),
    ) as unknown as typeof fetch;

    const { isServerRunning } = await import('./http');
    expect(await isServerRunning()).toBe(true);
  });

  test('returns false when fetch throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const { isServerRunning } = await import('./http');
    expect(await isServerRunning()).toBe(false);
  });
});

describe('stopServer', () => {
  test('returns true when server stops after POST succeeds', async () => {
    let callCount = 0;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('stopping', { status: 200 });
      callCount++;
      if (callCount >= 2) throw new Error('connection refused');
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const { stopServer } = await import('./http');
    expect(await stopServer()).toBe(true);
  });

  test('returns false when POST to stop endpoint fails', async () => {
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('error', { status: 500 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const { stopServer } = await import('./http');
    expect(await stopServer()).toBe(false);
  });

  test('returns false when fetch throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const { stopServer } = await import('./http');
    expect(await stopServer()).toBe(false);
  });

  test('returns false when server does not come down within timeout', async () => {
    globalThis.fetch = mock(
      async () => new Response('[]', { status: 200 }),
    ) as unknown as typeof fetch;

    const { stopServer } = await import('./http');
    expect(await stopServer('http://127.0.0.1:1', 100)).toBe(false);
  });
});

describe('startServer', () => {
  test('exits with error when server entry not found', async () => {
    spyOn(fs, 'existsSync').mockReturnValue(false);
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { startServer } = await import('./http');
    await startServer();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server entry not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    (fs.existsSync as ReturnType<typeof spyOn>).mockRestore();
  });
});

describe('openBrowser', () => {
  test('does nothing when WEBTTY_NO_OPEN=1', async () => {
    const origEnv = process.env.WEBTTY_NO_OPEN;
    process.env.WEBTTY_NO_OPEN = '1';
    const spawnSpy = spyOn(childProcess, 'spawn');

    const { openBrowser } = await import('./http');
    openBrowser('http://localhost:2346/s/main');
    expect(spawnSpy).not.toHaveBeenCalled();

    process.env.WEBTTY_NO_OPEN = origEnv;
    spawnSpy.mockRestore();
  });
});
