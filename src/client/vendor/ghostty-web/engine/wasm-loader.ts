// Derived from coder/ghostty-web lib/ghostty.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Reads and instantiates the official libghostty-vt wasm (service, ADR 041, ADR 047,
// ADR 061): from a given path, or from the pinned wasm beside this layer, through an
// injected file reader and fetch so the order and the errors can be tested.

import type { OfficialWasmExports } from './wasm-exports';

/** The pinned wasm, relative to this file (`vendor/ghostty-vt/`, two folders up). */
export const DEFAULT_WASM_URL = '../../ghostty-vt/ghostty-vt-small.wasm';

/** How the loader reads a wasm file, so tests can load without the network or the disk. */
export interface WasmLoaderDeps {
  /** A local file's bytes, or undefined when the path is not a readable file. */
  readFile(path: string): Promise<ArrayBuffer | undefined>;
  fetch(path: string): Promise<Response>;
}

/** Reads with `Bun.file` where Bun runs (tests, scripts); the browser has no local files. */
async function readBunFile(path: string): Promise<ArrayBuffer | undefined> {
  if (typeof Bun === 'undefined' || typeof Bun.file !== 'function') return undefined;
  try {
    const file = Bun.file(path);
    if (await file.exists()) return await file.arrayBuffer();
  } catch {
    // Not a readable file path; fetch it instead.
  }
  return undefined;
}

/** The production reader: `Bun.file` when there is one, then the global `fetch`. */
export const DEFAULT_WASM_LOADER_DEPS: WasmLoaderDeps = {
  readFile: readBunFile,
  fetch: (path) => fetch(path),
};

/**
 * The paths tried when no path is given, in order: the default URL as a file path (for
 * Bun), as a URL, then the page-relative and root names the build serves the wasm at.
 */
export function defaultWasmPaths(moduleUrl: URL): string[] {
  const paths: string[] = [];
  if (moduleUrl.protocol === 'file:') {
    let filePath = moduleUrl.pathname;
    // Remove leading slash on Windows paths (e.g., /C:/ -> C:/)
    if (filePath.match(/^\/[A-Za-z]:\//)) {
      filePath = filePath.slice(1);
    }
    paths.push(filePath);
  }
  paths.push(moduleUrl.href, './ghostty-vt-small.wasm', '/ghostty-vt-small.wasm');
  return paths;
}

/**
 * The wasm bytes at `path`: a local file if the reader finds one, else a fetch, which
 * must succeed and return a non-empty body.
 */
export async function readWasm(path: string, deps: WasmLoaderDeps): Promise<ArrayBuffer> {
  const local = await deps.readFile(path);
  if (local) return local;
  const response = await deps.fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM: ${response.status} ${response.statusText}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) {
    throw new Error(`WASM file is empty (0 bytes). Check path: ${path}`);
  }
  return bytes;
}

async function instantiateFrom(path: string, deps: WasmLoaderDeps): Promise<OfficialWasmExports> {
  const wasmModule = await WebAssembly.compile(await readWasm(path, deps));
  // The official wasm imports nothing.
  const instance = await WebAssembly.instantiate(wasmModule, {});
  return instance.exports as unknown as OfficialWasmExports;
}

/**
 * The exports of a new wasm instance, for `Ghostty.load`: from `wasmPath`, or else from
 * the first of the default paths that loads, throwing the last path's error if none does.
 */
export async function loadWasmExports(
  wasmPath?: string,
  deps: WasmLoaderDeps = DEFAULT_WASM_LOADER_DEPS,
  moduleUrl: URL = new URL(DEFAULT_WASM_URL, import.meta.url)
): Promise<OfficialWasmExports> {
  if (wasmPath) return instantiateFrom(wasmPath, deps);

  let lastError: Error | null = null;
  for (const path of defaultWasmPaths(moduleUrl)) {
    try {
      return await instantiateFrom(path, deps);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError || new Error('Failed to load Ghostty WASM');
}
