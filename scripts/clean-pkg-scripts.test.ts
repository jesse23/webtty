import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanPkgScripts, stripPackageJson } from './clean-pkg-scripts';

const PKG = `${JSON.stringify(
  {
    name: 'webtty',
    bin: { webtty: 'dist/cli/index.js' },
    scripts: { build: 'bun run scripts/build.ts' },
    dependencies: { ws: '8.21.3' },
    devDependencies: { typescript: '5.9.3' },
  },
  null,
  2,
)}\n`;

let dirs: string[] = [];
function pkgDir(files: Record<string, string> = { 'package.json': PKG }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-pkg-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('stripPackageJson', () => {
  test('drops scripts and devDependencies and keeps the rest in order', () => {
    expect(stripPackageJson(PKG)).toBe(
      `${JSON.stringify(
        { name: 'webtty', bin: { webtty: 'dist/cli/index.js' }, dependencies: { ws: '8.21.3' } },
        null,
        2,
      )}\n`,
    );
  });

  test('leaves a package without them as it was', () => {
    expect(stripPackageJson('{"name":"x"}')).toBe('{\n  "name": "x"\n}\n');
  });
});

describe('cleanPkgScripts', () => {
  const errors: unknown[][] = [];
  const error = (...args: unknown[]) => errors.push(args);
  afterEach(() => {
    errors.length = 0;
  });

  test('strip backs package.json up, then restore puts it back and removes the backup', () => {
    const dir = pkgDir();
    expect(cleanPkgScripts('strip', dir, error)).toBe(0);
    expect(read(dir, 'package.json')).toBe(stripPackageJson(PKG));
    expect(read(dir, 'package.json.bak')).toBe(PKG);
    expect(cleanPkgScripts('restore', dir, error)).toBe(0);
    expect(read(dir, 'package.json')).toBe(PKG);
    expect(fs.existsSync(path.join(dir, 'package.json.bak'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('strip refuses to overwrite a backup left by a failed publish', () => {
    const dir = pkgDir({ 'package.json': PKG, 'package.json.bak': 'old' });
    expect(cleanPkgScripts('strip', dir, error)).toBe(1);
    expect(read(dir, 'package.json')).toBe(PKG);
    expect(read(dir, 'package.json.bak')).toBe('old');
    expect(errors).toEqual([
      [
        'Error: package.json.bak already exists — a previous publish may have failed. Run restore first.',
      ],
    ]);
  });

  test('restore without a backup warns and still succeeds', () => {
    const dir = pkgDir();
    expect(cleanPkgScripts('restore', dir, error)).toBe(0);
    expect(read(dir, 'package.json')).toBe(PKG);
    expect(errors[0]?.[0]).toBe(
      'Warning: failed to restore package.json from backup — restore manually if needed.',
    );
    expect(errors[0]?.[1]).toBeInstanceOf(Error);
  });

  test.each([[undefined], ['pack']])('prints the usage for %p', (command) => {
    expect(cleanPkgScripts(command, pkgDir(), error)).toBe(1);
    expect(errors).toEqual([['Usage: clean-pkg-scripts.ts strip | restore']]);
  });

  test('runs in the current folder and reports to the console by default', () => {
    const dir = pkgDir();
    const proc = Bun.spawnSync(
      [process.execPath, path.join(import.meta.dir, 'clean-pkg-scripts.ts'), 'strip'],
      { cwd: dir },
    );
    expect(proc.exitCode).toBe(0);
    expect(read(dir, 'package.json')).toBe(stripPackageJson(PKG));
    const usage = Bun.spawnSync(
      [process.execPath, path.join(import.meta.dir, 'clean-pkg-scripts.ts')],
      {
        cwd: dir,
      },
    );
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr.toString()).toBe('Usage: clean-pkg-scripts.ts strip | restore\n');
  });
});
