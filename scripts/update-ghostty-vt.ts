// Vendors and verifies Ghostty's official libghostty-vt wasm (ReleaseSmall) into
// src/client/vendor/ghostty-vt/ (CLI entry, ADR 041, ADR 042, ADR 059). The work lives in
// scripts/ghostty-vt/; this file parses the flags and reports.
//
//   bun scripts/update-ghostty-vt.ts --commit <sha>   fetch and verify a new pin (network)
//   bun scripts/update-ghostty-vt.ts --verify         re-check the committed pin (offline)

import fs from 'node:fs';
import path from 'node:path';
import { inspectWasm } from './ghostty-vt/inspect-wasm';
import { fetchRelease, type ReleaseFetchDeps, releaseFetchDeps } from './ghostty-vt/release-fetch';
import { GHOSTTY_MINISIGN_PUBKEY, verifyPinned, WASM_FILE, writePin } from './ghostty-vt/sidecar';

// The vendor test (src/client/vendor/tests/ghostty-vt.test.ts) imports these from here.
export type { MinisigResult } from './ghostty-vt/minisign';
export { sha256, verifyMinisign } from './ghostty-vt/minisign';
export type { Sidecar } from './ghostty-vt/sidecar';
export { GHOSTTY_MINISIGN_PUBKEY, verifyPinned, WASM_FILE } from './ghostty-vt/sidecar';
export { inspectWasm };

/** Where the pin lives: the vendored, untouched official wasm. */
export const VENDOR_DIR = path.resolve(
  import.meta.dir,
  '..',
  'src',
  'client',
  'vendor',
  'ghostty-vt',
);

/** Where the CLI writes and what it prints through; tests pass a tmp dir and fakes. */
export interface CliDeps {
  dir: string;
  log(line: string): void;
  error(line: string): void;
  fetch: Partial<ReleaseFetchDeps>;
}

/** Fetches, verifies and writes the pin for Ghostty `commit` (the only networked step). */
export async function update(commit: string, deps: CliDeps): Promise<void> {
  const pin = await fetchRelease(commit, releaseFetchDeps(deps.fetch));
  writePin(deps.dir, pin);
  deps.log(`wrote ${WASM_FILE}{,.minisig,.json} and LICENSE for ${commit} to ${deps.dir}`);
  deps.log('Update PROVENANCE.md if needed, then re-run the binding tests (ADR 041).');
}

/** Re-checks the committed pin offline and prints what it verified. */
export async function verify(deps: CliDeps): Promise<void> {
  const { sidecar, sig } = verifyPinned(deps.dir, GHOSTTY_MINISIGN_PUBKEY);
  if (sidecar.publicKey !== GHOSTTY_MINISIGN_PUBKEY) {
    throw new Error(`sidecar key ${sidecar.publicKey} != ${GHOSTTY_MINISIGN_PUBKEY}`);
  }
  const wasm = await inspectWasm(
    new Uint8Array(fs.readFileSync(path.join(deps.dir, sidecar.file))),
  );
  deps.log(
    `OK ${sidecar.file} ${sidecar.sha256}, Ghostty ${sidecar.commit}, ${wasm.buildInfo.optimize}, ` +
      `signed by ${sig.keyId} (${sig.trustedComment})`,
  );
}

/** Runs the CLI on `args` and returns its exit code: 0, or 1 after printing the error. */
export async function runCli(args: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = {
    dir: VENDOR_DIR,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    fetch: {},
    ...overrides,
  };
  const commitAt = args.indexOf('--commit');
  try {
    if (args.includes('--verify')) await verify(deps);
    else if (commitAt >= 0 && args[commitAt + 1]) await update(args[commitAt + 1] as string, deps);
    else throw new Error('usage: update-ghostty-vt.ts --commit <sha> | --verify');
    return 0;
  } catch (err) {
    deps.error(`error: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
