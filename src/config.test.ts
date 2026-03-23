import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_THEME, loadConfig, saveConfig } from './config';

let tmpDir: string;
let configPath: string;

const origHome = os.homedir();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-config-test-'));
  configPath = path.join(tmpDir, '.config', 'webtty', 'config.jsonc');
  spyOn(os, 'homedir').mockReturnValue(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  spyOn(os, 'homedir').mockReturnValue(origHome);
});

describe('saveConfig', () => {
  test('creates the config directory if it does not exist', () => {
    saveConfig(DEFAULT_CONFIG);
    expect(fs.existsSync(path.dirname(configPath))).toBe(true);
  });

  test('writes a file that is valid JSON after stripping comments', () => {
    saveConfig(DEFAULT_CONFIG);
    const raw = fs.readFileSync(configPath, 'utf8');
    const stripped = raw.replace(/\/\/[^\n]*/g, '');
    expect(() => JSON.parse(stripped)).not.toThrow();
  });

  test('written file contains expected port and host values', () => {
    saveConfig(DEFAULT_CONFIG);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('"port": 2346');
    expect(raw).toContain('"host": "127.0.0.1"');
  });

  test('written file contains Dracula theme colors as comments', () => {
    saveConfig(DEFAULT_CONFIG);
    const raw = fs.readFileSync(configPath, 'utf8');
    expect(raw).toContain('#282A36');
    expect(raw).toContain('#F8F8F2');
  });
});

describe('loadConfig — first run', () => {
  test('creates the config file when it does not exist', () => {
    expect(fs.existsSync(configPath)).toBe(false);
    loadConfig();
    expect(fs.existsSync(configPath)).toBe(true);
  });

  test('returns config that equals DEFAULT_CONFIG after first run', () => {
    const config = loadConfig();
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.host).toBe(DEFAULT_CONFIG.host);
    expect(config.cols).toBe(DEFAULT_CONFIG.cols);
    expect(config.rows).toBe(DEFAULT_CONFIG.rows);
    expect(config.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(config.cursorBlink).toBe(DEFAULT_CONFIG.cursorBlink);
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
    const config = loadConfig();
    expect(config.port).toBe(9999);
  });

  test('overrides host when set in file', () => {
    writeConfig(JSON.stringify({ host: '0.0.0.0' }));
    const config = loadConfig();
    expect(config.host).toBe('0.0.0.0');
  });

  test('overrides shell when set in file', () => {
    writeConfig(JSON.stringify({ shell: '/bin/zsh' }));
    const config = loadConfig();
    expect(config.shell).toBe('/bin/zsh');
  });

  test('overrides fontSize and fontFamily when set in file', () => {
    writeConfig(JSON.stringify({ fontSize: 18, fontFamily: 'Menlo' }));
    const config = loadConfig();
    expect(config.fontSize).toBe(18);
    expect(config.fontFamily).toBe('Menlo');
  });

  test('overrides cursorBlink when set to false', () => {
    writeConfig(JSON.stringify({ cursorBlink: false }));
    const config = loadConfig();
    expect(config.cursorBlink).toBe(false);
  });

  test('overrides cols and rows when set in file', () => {
    writeConfig(JSON.stringify({ cols: 120, rows: 40 }));
    const config = loadConfig();
    expect(config.cols).toBe(120);
    expect(config.rows).toBe(40);
  });

  test('overrides scrollback when set in file', () => {
    writeConfig(JSON.stringify({ scrollback: 1024 }));
    const config = loadConfig();
    expect(config.scrollback).toBe(1024);
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

  test('ignores keys with wrong types (falls back to default)', () => {
    writeConfig(JSON.stringify({ port: 'not-a-number', cols: true, host: 42 }));
    const config = loadConfig();
    expect(config.port).toBe(DEFAULT_CONFIG.port);
    expect(config.cols).toBe(DEFAULT_CONFIG.cols);
    expect(config.host).toBe(DEFAULT_CONFIG.host);
  });

  test('strips JSONC comments before parsing', () => {
    writeConfig(`{
      // This is a comment
      "port": 5000 // inline comment
    }`);
    const config = loadConfig();
    expect(config.port).toBe(5000);
  });

  test('throws on invalid JSON', () => {
    writeConfig('{ not valid json }');
    expect(() => loadConfig()).toThrow(/invalid JSON/);
  });

  test('throws with file path in message on read error', () => {
    fs.mkdirSync(configPath, { recursive: true });
    expect(() => loadConfig()).toThrow(/webtty:/);
  });
});
