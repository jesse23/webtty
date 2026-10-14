import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { configDir, getConfigPath } from './config-paths';

let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
});

describe('configDir', () => {
  test('is ~/.config/webtty under an absolute HOME', () => {
    const home = path.join(os.tmpdir(), 'webtty-home');
    process.env.HOME = home;
    expect(configDir()).toBe(path.join(home, '.config', 'webtty'));
  });

  test.each([
    ['relative', 'relative/home'],
    ['the string "undefined"', 'undefined'],
    ['empty', ''],
  ])('falls back to os.homedir() when HOME is %s', (_label, home) => {
    process.env.HOME = home;
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'webtty'));
  });

  test('falls back to os.homedir() when HOME is unset', () => {
    delete process.env.HOME;
    expect(configDir()).toBe(path.join(os.homedir(), '.config', 'webtty'));
  });
});

describe('getConfigPath', () => {
  test('is config.json inside configDir()', () => {
    process.env.HOME = path.join(os.tmpdir(), 'webtty-home');
    expect(getConfigPath()).toBe(path.join(configDir(), 'config.json'));
  });
});
