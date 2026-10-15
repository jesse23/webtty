// Tests for the config service on a temporary HOME: the stub written on first run, reading and
// merging a config file, and the re-exports `../config` importers rely on (ADR 062).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as configModule from '.';
import { DEFAULT_CONFIG, DEFAULT_THEME, initConfig, loadConfig } from '.';

let tmpDir: string;
let configPath: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-config-test-'));
  configPath = path.join(tmpDir, '.config', 'webtty', 'config.json');
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
});

describe('initConfig', () => {
  test('creates the config directory if it does not exist', () => {
    initConfig();
    expect(fs.existsSync(path.dirname(configPath))).toBe(true);
  });

  test('writes valid JSON', () => {
    initConfig();
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('written file contains port and host', () => {
    initConfig();
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('"port"');
    expect(raw).toContain('"host"');
  });
});

describe('loadConfig — first run', () => {
  test('creates the config file when it does not exist', () => {
    expect(fs.existsSync(configPath)).toBe(false);
    loadConfig();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test('first run leaves fontFamily out of the file, so the default applies', () => {
    const config = loadConfig();
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('fontFamily');
    expect(config.fontFamily).toBe(DEFAULT_CONFIG.fontFamily);
  });

  test('returns config that equals DEFAULT_CONFIG after first run', () => {
    const config = loadConfig();
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.host).toBe(DEFAULT_CONFIG.host);
    expect(config.cols).toBe(DEFAULT_CONFIG.cols);
    expect(config.rows).toBe(DEFAULT_CONFIG.rows);
    expect(config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(config.cursorStyleBlink).toBe(DEFAULT_CONFIG.cursorStyleBlink);
    expect(config.cursorStyle).toBe(DEFAULT_CONFIG.cursorStyle);
    expect(config.scrollback).toBe(DEFAULT_CONFIG.scrollback);
    expect(config.theme).toEqual(DEFAULT_CONFIG.theme);
  });

  test('warns and returns defaults when write fails', () => {
    const configDir = path.dirname(configPath);
    fs.mkdirSync(path.dirname(configDir), { recursive: true });
    fs.writeFileSync(configDir, 'not-a-dir');

    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args.join(' '));

    let config: ReturnType<typeof loadConfig> | undefined;
    expect(() => {
      config = loadConfig();
    }).not.toThrow();

    console.warn = origWarn;

    expect(warned.some((w) => w.includes('webtty:'))).toBe(true);
    expect(config?.port).toBe(DEFAULT_CONFIG.port);
  });
});

describe('loadConfig — reads and merges', () => {
  function writeConfig(content: string) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, 'utf8');
  }

  test('returns full defaults when file has no overrides', () => {
    writeConfig('{}');
    const config = loadConfig();
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.cols).toBe(DEFAULT_CONFIG.cols);
    expect(config.theme).toEqual(DEFAULT_THEME);
  });

  test('overrides port when set in file', () => {
    writeConfig(JSON.stringify({ port: 9999 }));
    expect(loadConfig().port).toBe(9999);
  });

  test('merges partial theme over DEFAULT_THEME', () => {
    writeConfig(JSON.stringify({ theme: { background: '#000000' } }));
    const config = loadConfig();
    expect(config.theme.background).toBe('#000000');
    expect(config.theme.foreground).toBe(DEFAULT_THEME.foreground);
    expect(config.theme.red).toBe(DEFAULT_THEME.red);
  });

  test('throws on invalid JSON', () => {
    writeConfig('{ not valid json }');
    expect(() => loadConfig()).toThrow(/invalid JSON/);
  });

  test('throws with webtty: prefix in message on read error', () => {
    fs.mkdirSync(configPath, { recursive: true });
    expect(() => loadConfig()).toThrow(/webtty:/);
  });
});

describe('config index — re-exports', () => {
  test('keeps every name src/config.ts exported before the split', () => {
    for (const name of [
      'configDir',
      'parseRightClickBehavior',
      'DEFAULT_THEME',
      'DEFAULT_KEYBOARD_BINDINGS',
      'DEFAULT_CONFIG',
      'mergeKeyboardBindings',
      'loadConfig',
      'initConfig',
    ]) {
      expect(name in configModule).toBe(true);
    }
  });

  test('also exports the client key list, its view, the parser and the path', () => {
    expect(configModule.CLIENT_CONFIG_KEYS).toContain('cols');
    expect(typeof configModule.toClientConfig).toBe('function');
    expect(typeof configModule.parseConfig).toBe('function');
    expect(configModule.getConfigPath()).toBe(configPath);
  });
});
