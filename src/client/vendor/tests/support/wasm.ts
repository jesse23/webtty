// The vendored tests' one way to the official wasm (test support, ADR 064): its path, the
// folders beside it, and Ghostty instances built from a single compile, so a test file
// that opens many terminals does not compile the wasm for each one.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ghostty } from '../../ghostty-web/ghostty';

const VENDOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The pinned ghostty-vt folder (wasm, sidecar, signature, licence) the integrity test reads. */
export const GHOSTTY_VT_DIR = path.join(VENDOR_DIR, 'ghostty-vt');

/** The official libghostty-vt wasm every engine test runs on (ADR 042, ADR 047). */
export const WASM_PATH = path.join(GHOSTTY_VT_DIR, 'ghostty-vt-small.wasm');

/** The PTY captures the replay test feeds the engine. */
export const FIXTURES_DIR = path.join(VENDOR_DIR, 'tests', 'fixtures');

let compiled: Promise<WebAssembly.Module> | undefined;

/** The wasm, read and compiled on first use and shared by every later call. */
export function compiledWasm(): Promise<WebAssembly.Module> {
  compiled ??= Bun.file(WASM_PATH)
    .arrayBuffer()
    .then((bytes) => WebAssembly.compile(bytes));
  return compiled;
}

/** A fresh instance with its own memory, for tests that wrap or count the raw exports. */
export async function instantiateWasm(): Promise<WebAssembly.Instance> {
  return WebAssembly.instantiate(await compiledWasm(), {});
}

/**
 * A Ghostty on a fresh instance, as `Ghostty.load` builds one (the official wasm imports
 * nothing), without reading and compiling the file again.
 */
export async function loadGhostty(): Promise<Ghostty> {
  const instance = await instantiateWasm();
  return new Ghostty(instance.exports as unknown as ConstructorParameters<typeof Ghostty>[0]);
}
