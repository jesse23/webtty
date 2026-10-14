import { describe, expect, test } from 'bun:test';
import {
  bunTerminalAvailable,
  isWindows,
  launchedFromBunExecutable,
  packageRunner,
  processRuntime,
  type RuntimeEnv,
  runningUnderBun,
} from './runtime';

function env(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    platform: 'linux',
    execPath: '/usr/bin/node',
    bunVersion: undefined,
    bunGlobal: undefined,
    ...overrides,
  };
}

describe('processRuntime', () => {
  test('reflects the live process', () => {
    const live = processRuntime();
    expect(live.platform).toBe(process.platform);
    expect(live.execPath).toBe(process.execPath);
    expect(live.bunVersion).toBe(process.versions.bun);
    expect(live.bunGlobal).toBe((globalThis as Record<string, unknown>).Bun);
  });

  test('predicates default to the live process', () => {
    expect(isWindows()).toBe(process.platform === 'win32');
    expect(runningUnderBun()).toBe(true); // the test runner is Bun
    expect(launchedFromBunExecutable()).toBe(process.execPath.includes('bun'));
    expect(bunTerminalAvailable()).toBe(process.platform !== 'win32');
    expect(packageRunner()).toBe(process.execPath.includes('bun') ? 'bunx' : 'npx');
  });
});

describe('isWindows', () => {
  test.each([
    ['win32', true],
    ['linux', false],
    ['darwin', false],
  ])('%s → %p', (platform, expected) => {
    expect(isWindows(env({ platform }))).toBe(expected);
  });
});

describe('bunTerminalAvailable', () => {
  test.each([
    ['bun on linux', { bunVersion: '1.3.0', platform: 'linux' }, true],
    ['bun on darwin', { bunVersion: '1.3.0', platform: 'darwin' }, true],
    ['bun on windows', { bunVersion: '1.3.0', platform: 'win32' }, false],
    ['node on linux', { bunVersion: undefined, platform: 'linux' }, false],
    ['empty bun version', { bunVersion: '', platform: 'linux' }, false],
  ])('%s', (_name, overrides, expected) => {
    expect(bunTerminalAvailable(env(overrides))).toBe(expected);
  });
});

describe('launchedFromBunExecutable / packageRunner', () => {
  test.each([
    ['/home/u/.bun/bin/bun', true, 'bunx'],
    ['C:\\Users\\u\\.bun\\bin\\bun.exe', true, 'bunx'],
    ['/usr/local/bin/node', false, 'npx'],
  ])('%s', (execPath, fromBun, runner) => {
    expect(launchedFromBunExecutable(env({ execPath }))).toBe(fromBun);
    expect<string>(packageRunner(env({ execPath }))).toBe(runner);
  });
});

describe('runningUnderBun', () => {
  test.each([
    ['Bun global present', {}, true],
    ['Bun global absent', undefined, false],
  ])('%s', (_name, bunGlobal, expected) => {
    expect(runningUnderBun(env({ bunGlobal }))).toBe(expected);
  });
});
