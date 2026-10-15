import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sidecar } from './ghostty-vt/sidecar';
import { fakeReleaseFetch } from './ghostty-vt/test-support/fake-release';
import * as cli from './update-ghostty-vt';
import { type CliDeps, runCli, VENDOR_DIR, WASM_FILE } from './update-ghostty-vt';

const FILES = ['LICENSE', WASM_FILE, `${WASM_FILE}.json`, `${WASM_FILE}.minisig`];
const SIDECAR = JSON.parse(
  fs.readFileSync(path.join(VENDOR_DIR, `${WASM_FILE}.json`), 'utf8'),
) as Sidecar;

let dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-vt-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Runs the CLI with its output captured. */
async function run(args: string[], overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    ...overrides,
  });
  return { code, out, err };
}

describe('update-ghostty-vt.ts', () => {
  test('--verify passes offline on the committed pin', async () => {
    const { code, out, err } = await run(['--verify']);
    expect({ code, err }).toEqual({ code: 0, err: [] });
    expect(out).toEqual([
      `OK ${WASM_FILE} ${SIDECAR.sha256}, Ghostty ${SIDECAR.commit}, ReleaseSmall, ` +
        `signed by F5787DDB42320225 (${SIDECAR.signature.trustedComment})`,
    ]);
  });

  test('--verify refuses a sidecar that names another key', async () => {
    const dir = tmpDir();
    for (const name of FILES) fs.copyFileSync(path.join(VENDOR_DIR, name), path.join(dir, name));
    const edited = { ...SIDECAR, publicKey: 'other' };
    fs.writeFileSync(path.join(dir, `${WASM_FILE}.json`), JSON.stringify(edited));
    const { code, err } = await run(['--verify'], { dir });
    expect(code).toBe(1);
    expect(err).toEqual([`error: sidecar key other != ${cli.GHOSTTY_MINISIGN_PUBKEY}`]);
  });

  test('--commit fetches, writes the pin into the dir and says what to do next', async () => {
    const dir = path.join(tmpDir(), 'ghostty-vt');
    const fake = fakeReleaseFetch({
      commit: SIDECAR.commit,
      wasm: new Uint8Array(fs.readFileSync(path.join(VENDOR_DIR, WASM_FILE))),
      minisig: fs.readFileSync(path.join(VENDOR_DIR, `${WASM_FILE}.minisig`), 'utf8'),
      license: fs.readFileSync(path.join(VENDOR_DIR, 'LICENSE'), 'utf8'),
      commitDate: SIDECAR.commitDate,
    });
    const now = () => new Date(SIDECAR.verifiedAt);
    const { code, out } = await run(['--commit', SIDECAR.commit], {
      dir,
      fetch: { fetch: fake.fetch, now },
    });
    expect(code).toBe(0);
    expect(out).toEqual([
      `wrote ${WASM_FILE}{,.minisig,.json} and LICENSE for ${SIDECAR.commit} to ${dir}`,
      'Update PROVENANCE.md if needed, then re-run the binding tests (ADR 041).',
    ]);
    for (const name of FILES) {
      expect(fs.readFileSync(path.join(dir, name))).toEqual(
        fs.readFileSync(path.join(VENDOR_DIR, name)),
      );
    }
    expect((await run(['--verify'], { dir })).code).toBe(0);
  });

  test.each([[[]], [['--commit']], [['--other']]])('prints the usage for %j', async (args) => {
    const { code, out, err } = await run(args);
    expect({ code, out, err }).toEqual({
      code: 1,
      out: [],
      err: ['error: usage: update-ghostty-vt.ts --commit <sha> | --verify'],
    });
  });

  test('prints to the console by default', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runCli(['--verify'])).toBe(0);
      expect(await runCli([])).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        'error: usage: update-ghostty-vt.ts --commit <sha> | --verify',
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test.each([
    [['--verify'], 0, `OK ${WASM_FILE} `],
    [[], 1, ''],
  ])('as a process, %j exits %d', (args, exitCode, stdout) => {
    const proc = Bun.spawnSync([
      process.execPath,
      path.join(import.meta.dir, 'update-ghostty-vt.ts'),
      ...args,
    ]);
    expect(proc.exitCode).toBe(exitCode);
    expect(proc.stdout.toString()).toStartWith(stdout);
  });

  test('re-exports what the vendor test imports', () => {
    expect(typeof cli.verifyMinisign).toBe('function');
    expect(typeof cli.verifyPinned).toBe('function');
    expect(typeof cli.inspectWasm).toBe('function');
    expect(typeof cli.sha256).toBe('function');
    expect(VENDOR_DIR.endsWith(path.join('src', 'client', 'vendor', 'ghostty-vt'))).toBe(true);
  });
});
