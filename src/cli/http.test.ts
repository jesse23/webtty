import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function withPlatform(platform: string, fn: () => void): void {
  const origNodeEnv = process.env.NODE_ENV;
  const origPlatform = process.platform;
  delete process.env.NODE_ENV;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    process.env.NODE_ENV = origNodeEnv;
  }
}

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

describe('logPath', () => {
  test('returns path inside ~/.config/webtty/', async () => {
    const { logPath } = await import('./http');
    expect(logPath()).toBe(path.join(os.homedir(), '.config', 'webtty', 'server.log'));
  });
});

describe('startServer', () => {
  test('opens log file and passes fd to spawn when logs is true', async () => {
    const mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const openSpy = spyOn(fs, 'openSync').mockReturnValue(99);
    const closeSpy = spyOn(fs, 'closeSync').mockImplementation(() => {});
    const fakeChild = { unref: mock(() => {}) };
    const spawnMock = mock(() => fakeChild);

    globalThis.fetch = mock(
      async () => new Response('[]', { status: 200 }),
    ) as unknown as typeof fetch;

    const configModule = await import('../config');
    const configSpy = spyOn(configModule, 'loadConfig').mockReturnValue({
      ...configModule.DEFAULT_CONFIG,
      logs: true,
    });

    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);

    const { startServer } = await import('./http');
    await startServer(10000, spawnMock as never);

    const spawnCall = (spawnMock.mock.calls[0] as unknown[])[2] as unknown as { stdio: unknown };
    expect(spawnCall.stdio).toEqual(['ignore', 99, 99]);
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('server.log'), 'a');
    expect(closeSpy).toHaveBeenCalledWith(99);

    existsSpy.mockRestore();
    mkdirSpy.mockRestore();
    openSpy.mockRestore();
    closeSpy.mockRestore();
    configSpy.mockRestore();
  });

  test('exits with error when server entry not found', async () => {
    const realExistsSync = fs.existsSync.bind(fs);
    const existsSpy = spyOn(fs, 'existsSync').mockImplementation((p) =>
      String(p).includes('server/index') ? false : realExistsSync(p),
    );
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const { startServer } = await import('./http');
    await startServer();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server entry not found'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    existsSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('spawns server and resolves when it becomes reachable', async () => {
    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    const fakeChild = { unref: mock(() => {}) };
    const spawnMock = mock(() => fakeChild);

    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls++;
      if (calls < 3) throw new Error('not yet');
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const { startServer } = await import('./http');
    await startServer(10000, spawnMock as never);

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(fakeChild.unref).toHaveBeenCalled();

    existsSpy.mockRestore();
  });

  test('exits with error when server does not start within timeout', async () => {
    const existsSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    const spawnMock = mock(() => ({ unref: () => {} }));
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as () => never);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    globalThis.fetch = mock(async () => {
      throw new Error('not yet');
    }) as unknown as typeof fetch;

    const { startServer } = await import('./http');
    await startServer(100, spawnMock as never);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('server did not start in time'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    existsSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('openBrowser', () => {
  test('does nothing when WEBTTY_NO_OPEN=1', async () => {
    const origEnv = process.env.WEBTTY_NO_OPEN;
    process.env.WEBTTY_NO_OPEN = '1';
    const spawnMock = mock(() => ({ unref: () => {} }));

    const { openBrowser } = await import('./http');
    openBrowser('http://localhost:2346/s/main', spawnMock as never);
    expect(spawnMock).not.toHaveBeenCalled();

    process.env.WEBTTY_NO_OPEN = origEnv;
  });

  test('spawns open on darwin', async () => {
    const spawnMock = mock(() => ({ unref: () => {} }));
    const { openBrowser } = await import('./http');
    withPlatform('darwin', () => openBrowser('http://localhost:2346/s/main', spawnMock as never));
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['http://localhost:2346/s/main'],
      expect.anything(),
    );
  });

  test('spawns xdg-open on linux', async () => {
    const spawnMock = mock(() => ({ unref: () => {} }));
    const { openBrowser } = await import('./http');
    withPlatform('linux', () => openBrowser('http://localhost:2346/s/main', spawnMock as never));
    expect(spawnMock).toHaveBeenCalledWith(
      'xdg-open',
      ['http://localhost:2346/s/main'],
      expect.anything(),
    );
  });

  test('spawns cmd.exe on win32', async () => {
    const spawnMock = mock(() => ({ unref: () => {} }));
    const { openBrowser } = await import('./http');
    withPlatform('win32', () => openBrowser('http://localhost:2346/s/main', spawnMock as never));
    expect(spawnMock).toHaveBeenCalledWith(
      'cmd.exe',
      expect.arrayContaining(['start']),
      expect.anything(),
    );
  });
});
