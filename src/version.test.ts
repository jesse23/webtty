// Tests for the package version: the walk up to package.json on a temporary tree, and the
// bundled CLI and server entries reporting the version of the package they ship in (ADR 062).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanupTmpHome,
  getFreePort,
  makeTmpHome,
  waitForServer,
} from './test-support/server-harness';
import { findPackageVersion, getVersion } from './version';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const FAKE_VERSION = '9.9.9';
const NODE = Bun.which('node');

describe('getVersion', () => {
  test('matches the version in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(getVersion()).toBe(pkg.version);
  });

  test('a second call returns the cached version', () => {
    expect(getVersion()).toBe(getVersion());
  });
});

describe('findPackageVersion', () => {
  let root: string;
  let leaf: string;

  beforeAll(() => {
    root = makeTmpHome('version-walk');
    leaf = path.join(root, 'pkg', 'nested', 'deeper');
    fs.mkdirSync(leaf, { recursive: true });
    // Walking up from `leaf`: a broken file, then another package, then webtty.
    fs.writeFileSync(path.join(root, 'pkg', 'nested', 'deeper', 'package.json'), '{not json');
    fs.writeFileSync(
      path.join(root, 'pkg', 'nested', 'package.json'),
      JSON.stringify({ name: 'other', version: '1.0.0' }),
    );
    fs.writeFileSync(
      path.join(root, 'pkg', 'package.json'),
      JSON.stringify({ name: 'webtty', version: '2.3.4' }),
    );
  });

  afterAll(() => cleanupTmpHome(root));

  test('skips unreadable and unrelated package.json files on the way up', () => {
    expect(findPackageVersion(leaf)).toBe('2.3.4');
  });

  test('a webtty package.json without a version does not count', () => {
    const bare = path.join(root, 'bare');
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'webtty' }));
    expect(findPackageVersion(bare)).toBe(findPackageVersion(root));
  });

  test("is 'unknown' when the walk reaches the root without a webtty package", () => {
    expect(findPackageVersion(root)).toBe('unknown');
  });
});

// Bundles the CLI and server the way scripts/build.ts does, into a throwaway
// package whose package.json carries a distinctive version. Seeing FAKE_VERSION
// proves the bundled entries find the package.json above dist/, rather than the
// repo's own (a bundler/import.meta.url regression would surface here).
describe('getVersion — bundled dist', () => {
  let pkgRoot: string;
  let home: string;
  let cliEntry: string;
  let serverEntry: string;

  beforeAll(async () => {
    pkgRoot = makeTmpHome('version-pkg');
    home = makeTmpHome('version-home');
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'webtty', version: FAKE_VERSION }),
    );
    // Externals (ws, node-pty) resolve at runtime from the package root.
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(pkgRoot, 'node_modules'),
      'junction',
    );

    const result = await Bun.build({
      entrypoints: [
        path.join(REPO_ROOT, 'src/server/index.ts'),
        path.join(REPO_ROOT, 'src/cli/index.ts'),
      ],
      outdir: path.join(pkgRoot, 'dist'),
      target: 'node',
      format: 'esm',
      external: ['@lydell/node-pty', 'ws'],
    });
    if (!result.success) throw new Error(`bundle failed: ${result.logs.join('\n')}`);
    // The server needs the wasm at startup; the published package ships it in dist/.
    fs.copyFileSync(
      path.join(REPO_ROOT, 'src/client/vendor/ghostty-vt/ghostty-vt-small.wasm'),
      path.join(pkgRoot, 'dist/ghostty-vt-small.wasm'),
    );
    cliEntry = path.join(pkgRoot, 'dist/cli/index.js');
    serverEntry = path.join(pkgRoot, 'dist/server/index.js');
  });

  afterAll(() => {
    cleanupTmpHome(pkgRoot);
    cleanupTmpHome(home);
  });

  const runtimes: [string, string | null | undefined][] = [
    ['bun', process.execPath],
    ['node', NODE],
  ];

  for (const [name, exec] of runtimes) {
    test.skipIf(!exec)(`dist/cli --version reports the package version under ${name}`, () => {
      const out = spawnSync(exec as string, [cliEntry, '--version'], {
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      expect(out.stdout.trim()).toBe(FAKE_VERSION);
    });

    test.skipIf(!exec)(`dist/server serves the package version under ${name}`, async () => {
      const port = await getFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const proc: ChildProcess = spawn(exec as string, [serverEntry], {
        env: {
          ...process.env,
          PORT: String(port),
          HOME: home,
          ...(process.platform !== 'win32' && { SHELL: '/bin/sh' }),
        },
        stdio: 'ignore',
      });
      try {
        await waitForServer(baseUrl);
        const res = await fetch(`${baseUrl}/api/server/status`);
        expect(((await res.json()) as { version: string }).version).toBe(FAKE_VERSION);
      } finally {
        proc.kill();
      }
    });
  }
});
