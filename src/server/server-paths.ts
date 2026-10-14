// Where the server finds its files: the package root, the client page and bundle, and the
// libghostty-vt wasm. A pure util over an injected `existsSync`; the one module that knows how
// deep src/server and dist/server sit (ADR 062).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GHOSTTY_WASM } from './http/static-files';

/** The files the server serves, resolved once at startup. */
export interface ServerPaths {
  /** The package root: the checkout in development, the installed package from npm. */
  projectRoot: string;
  /** The directory holding client.html and the bundle: `dist/` once built, else `src/client/`. */
  clientRoot: string;
  /** The wasm served at `/ghostty-vt-small.wasm`. */
  wasmPath: string;
}

/** The one filesystem call path resolution makes, injected so tests can lay out either tree. */
export type ExistsSync = (p: string) => boolean;

/** Thrown when neither the built nor the vendored wasm exists; the entry prints it and exits 1. */
export class MissingWasmError extends Error {
  constructor() {
    super(`Could not find ${GHOSTTY_WASM}.`);
    this.name = 'MissingWasmError';
  }
}

/**
 * The package root for a module in `src/server/` or in `dist/server/` (the bundled entry):
 * both sit two levels below it.
 *
 * @param moduleDir - The directory of the running server module.
 */
export function projectRootOf(moduleDir: string): string {
  return path.resolve(moduleDir, '..', '..');
}

/**
 * Locates {@link GHOSTTY_WASM}, preferring the copy the build puts in `dist/` (npm install)
 * over the vendored source copy (local dev).
 *
 * @throws {MissingWasmError} if neither exists.
 */
export function findWasm(projectRoot: string, existsSync: ExistsSync): string {
  const candidates = [
    path.join(projectRoot, 'dist', GHOSTTY_WASM),
    path.join(projectRoot, 'src', 'client', 'vendor', 'ghostty-vt', GHOSTTY_WASM),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new MissingWasmError();
  return found;
}

/**
 * The client directory: `dist/` when the build has put client.html there, else `src/client/`,
 * which serves the unbundled page in a fresh checkout.
 */
export function findClientRoot(projectRoot: string, existsSync: ExistsSync): string {
  const builtDistPath = path.join(projectRoot, 'dist');
  return existsSync(path.join(builtDistPath, 'client.html'))
    ? builtDistPath
    : path.join(projectRoot, 'src', 'client');
}

/**
 * Resolves every path the server needs. The production defaults are this module's own
 * directory and the real filesystem.
 *
 * @throws {MissingWasmError} if the wasm cannot be found.
 */
export function resolveServerPaths(
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  existsSync: ExistsSync = fs.existsSync,
): ServerPaths {
  const projectRoot = projectRootOf(moduleDir);
  const wasmPath = findWasm(projectRoot, existsSync);
  const clientRoot = findClientRoot(projectRoot, existsSync);
  return { projectRoot, clientRoot, wasmPath };
}
