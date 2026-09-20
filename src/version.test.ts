import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupTmpHome, getFreePort, makeTmpHome, waitForServer } from './utils.test';
import { getVersion } from './version';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const FAKE_VERSION = '9.9.9';
const NODE = Bun.which('node');

describe('getVersion', () => {
  test('matches the version in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(getVersion()).toBe(pkg.version);
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
    // Externals (ws, node-pty, ghostty-web) resolve at runtime from the package root.
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
      external: ['@lydell/node-pty', 'ws', 'ghostty-web'],
    });
    if (!result.success) throw new Error(`bundle failed: ${result.logs.join('\n')}`);
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
