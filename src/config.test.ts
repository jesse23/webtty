import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_THEME, initConfig, loadConfig } from './config';

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

describe('saveConfig', () => {
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

  test('DEFAULT_CONFIG.term is xterm-256color regardless of $TERM env', () => {
    const saved = process.env.TERM;
    process.env.TERM = 'alacritty';
    expect(DEFAULT_CONFIG.term).toBe('xterm-256color');
    if (saved === undefined) delete process.env.TERM;
    else process.env.TERM = saved;
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

  test('overrides host when set in file', () => {
    writeConfig(JSON.stringify({ host: '0.0.0.0' }));
    expect(loadConfig().host).toBe('0.0.0.0');
  });

  test('overrides shell when set in file', () => {
    writeConfig(JSON.stringify({ shell: '/bin/zsh' }));
    expect(loadConfig().shell).toBe('/bin/zsh');
  });

  test('overrides fontSize and fontFamily when set in file', () => {
    writeConfig(JSON.stringify({ fontSize: 18, fontFamily: 'Menlo' }));
    const config = loadConfig();
    expect(config.fontSize).toBe(18);
    expect(config.fontFamily).toBe('Menlo');
  });

  test('overrides cursorStyleBlink when set to false', () => {
    writeConfig(JSON.stringify({ cursorStyleBlink: false }));
    expect(loadConfig().cursorStyleBlink).toBe(false);
  });

  test('overrides cursorStyle when set to a valid value', () => {
    writeConfig(JSON.stringify({ cursorStyle: 'underline' }));
    expect(loadConfig().cursorStyle).toBe('underline');
  });

  test('falls back cursorStyle to default for invalid value', () => {
    writeConfig(JSON.stringify({ cursorStyle: 'bogus' }));
    expect(loadConfig().cursorStyle).toBe(DEFAULT_CONFIG.cursorStyle);
  });

  test('overrides cols and rows when set in file', () => {
    writeConfig(JSON.stringify({ cols: 120, rows: 40 }));
    const config = loadConfig();
    expect(config.cols).toBe(120);
    expect(config.rows).toBe(40);
  });

  test('overrides scrollback when set in file', () => {
    writeConfig(JSON.stringify({ scrollback: 1024 }));
    expect(loadConfig().scrollback).toBe(1024);
  });

  test('merges partial theme over DEFAULT_THEME', () => {
    writeConfig(JSON.stringify({ theme: { background: '#000000' } }));
    const config = loadConfig();
    expect(config.theme.background).toBe('#000000');
    expect(config.theme.foreground).toBe(DEFAULT_THEME.foreground);
    expect(config.theme.red).toBe(DEFAULT_THEME.red);
  });

  test('ignores unknown keys', () => {
    writeConfig(JSON.stringify({ unknownKey: 'value', port: 1234 }));
    const config = loadConfig();
    expect(config.port).toBe(1234);
    expect((config as unknown as Record<string, unknown>).unknownKey).toBeUndefined();
  });

  test('ignores keys with wrong types and falls back to defaults', () => {
    writeConfig(JSON.stringify({ port: 'not-a-number', cols: true, host: 42 }));
    const config = loadConfig();
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.cols).toBe(DEFAULT_CONFIG.cols);
    expect(config.host).toBe(DEFAULT_CONFIG.host);
  });

  test('overrides copyOnSelect when set to false', () => {
    writeConfig(JSON.stringify({ copyOnSelect: false }));
    expect(loadConfig().copyOnSelect).toBe(false);
  });

  test('overrides rightClickBehavior when set to copyPaste', () => {
    writeConfig(JSON.stringify({ rightClickBehavior: 'copyPaste' }));
    expect(loadConfig().rightClickBehavior).toBe('copyPaste');
  });

  test('falls back rightClickBehavior to default for invalid value', () => {
    writeConfig(JSON.stringify({ rightClickBehavior: 'bogus' }));
    expect(loadConfig().rightClickBehavior).toBe('default');
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
