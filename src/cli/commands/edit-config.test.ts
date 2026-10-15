// Tests for `webtty config` over a fake EditorHost: the `{}` written when the file is missing,
// the editor from $VISUAL, $EDITOR or the platform, and the live host's filesystem calls (ADR 063).
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeCliDeps } from '../test-support/fake-cli-deps';
import { type EditorHost, editConfig, processEditorHost } from './edit-config';

/** An editor host over an in-memory file set that records the editor it ran. */
function fakeEditor(env: NodeJS.ProcessEnv, platform = 'linux', existing: string[] = []) {
  const calls: string[] = [];
  const files = new Map<string, string>(existing.map((f) => [f, 'kept']));
  const editor: EditorHost = {
    configDir: () => '/home/u/.config/webtty',
    mkdirp: (dir) => calls.push(`mkdirp ${dir}`),
    exists: (file) => files.has(file),
    writeFile: (file, text) => {
      calls.push(`write ${file}`);
      files.set(file, text);
    },
    env,
    platform,
    runAttached: (command, args) => calls.push(`run ${command} ${args.join(' ')}`),
  };
  return { editor, calls, files };
}

const CONFIG = '/home/u/.config/webtty/config.json';

describe('editConfig', () => {
  test('creates a missing config as {} and opens it in $VISUAL', () => {
    const fake = fakeEditor({ VISUAL: 'code -w', EDITOR: 'nano' });
    editConfig(fakeCliDeps({}, { editor: fake.editor }).deps);
    expect(fake.calls).toEqual([
      'mkdirp /home/u/.config/webtty',
      `write ${CONFIG}`,
      `run code -w ${CONFIG}`,
    ]);
    expect(fake.files.get(CONFIG)).toBe('{}\n');
  });

  test('leaves an existing config alone', () => {
    const fake = fakeEditor({ EDITOR: 'nano' }, 'linux', [CONFIG]);
    editConfig(fakeCliDeps({}, { editor: fake.editor }).deps);
    expect(fake.calls).toEqual(['mkdirp /home/u/.config/webtty', `run nano ${CONFIG}`]);
    expect(fake.files.get(CONFIG)).toBe('kept');
  });

  const fallbacks: Array<[string, string]> = [
    ['win32', 'notepad'],
    ['darwin', 'vi'],
    ['linux', 'vi'],
  ];
  for (const [platform, editorName] of fallbacks) {
    test(`with neither variable set, ${platform} uses ${editorName}`, () => {
      const fake = fakeEditor({}, platform, [CONFIG]);
      editConfig(fakeCliDeps({}, { editor: fake.editor }).deps);
      expect(fake.calls.at(-1)).toBe(`run ${editorName} ${CONFIG}`);
    });
  }
});

describe('processEditorHost', () => {
  test('reads the live environment and platform', () => {
    const host = processEditorHost();
    expect(host.env).toBe(process.env);
    expect(host.platform).toBe(process.platform);
    expect(host.configDir()).toBe(path.join(os.homedir(), '.config', 'webtty'));
  });

  test('creates directories, checks and writes files, and runs a command to completion', () => {
    const host = processEditorHost();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-editor-'));
    try {
      const nested = path.join(dir, 'a', 'b');
      host.mkdirp(nested);
      const file = path.join(nested, 'config.json');
      expect(host.exists(file)).toBe(false);
      host.writeFile(file, '{}\n');
      expect(host.exists(file)).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).toBe('{}\n');
      host.runAttached(process.execPath, [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(file)}, 'ran')`,
      ]);
      expect(fs.readFileSync(file, 'utf8')).toBe('ran');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
