import { describe, expect, mock, test } from 'bun:test';
import {
  type BrowserOpenerHost,
  openBrowser,
  processBrowserHost,
  toBrowserHost,
} from './browser-opener';

const URL = 'http://localhost:2346/s/main';

describe('toBrowserHost', () => {
  const cases: Array<[string, string]> = [
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['0.0.0.0', 'localhost'],
    ['::', 'localhost'],
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
  ];
  for (const [host, expected] of cases) {
    test(`${host} → ${expected}`, () => {
      expect(toBrowserHost(host)).toBe(expected);
    });
  }
});

/** A host on `platform` with a recording spawn and no opt-out variables. */
function fakeHost(platform: string, env: NodeJS.ProcessEnv = {}) {
  const unref = mock(() => {});
  const spawn = mock(() => ({ unref }));
  const host: BrowserOpenerHost = { spawn, platform, env };
  return { host, spawn, unref };
}

describe('openBrowser', () => {
  test('does nothing when WEBTTY_NO_OPEN=1', () => {
    const { host, spawn } = fakeHost('darwin', { WEBTTY_NO_OPEN: '1' });
    openBrowser(URL, host);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('does nothing when NODE_ENV=test', () => {
    const { host, spawn } = fakeHost('darwin', { NODE_ENV: 'test' });
    openBrowser(URL, host);
    expect(spawn).not.toHaveBeenCalled();
  });

  const cases: Array<[string, string, string[]]> = [
    ['darwin', 'open', [URL]],
    ['linux', 'xdg-open', [URL]],
    ['win32', 'cmd.exe', ['/c', 'start', '', URL]],
  ];
  for (const [platform, command, args] of cases) {
    test(`spawns ${command} on ${platform}, detached and unref'd`, () => {
      const { host, spawn, unref } = fakeHost(platform);
      openBrowser(URL, host);
      expect(spawn).toHaveBeenCalledWith(command, args, { detached: true, stdio: 'ignore' });
      expect(unref).toHaveBeenCalled();
    });
  }

  test('the default host is the live process', () => {
    const host = processBrowserHost();
    expect(host.platform).toBe(process.platform);
    expect(host.env).toBe(process.env);
  });

  test('with the default host under bun test it opens nothing', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => openBrowser(URL)).not.toThrow();
  });
});
