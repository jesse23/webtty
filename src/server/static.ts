import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** File extension → MIME type map used by {@link serveFile}. */
export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Returns the MIME type for `filePath` based on its extension, defaulting to `application/octet-stream`.
 *
 * @param filePath - The file path to determine the MIME type for.
 * @returns The MIME type string.
 */
export function mimeType(filePath: string): string {
  const ext = path.extname(filePath);
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The wasm files the server serves at `GET /<file>`, each with the directory under
 * `src/client/vendor/` it is vendored in: the Coder engine's `ghostty-vt.wasm` (ADR 041)
 * and the official libghostty-vt `ghostty-vt-small.wasm` (ADR 042).
 */
export const GHOSTTY_WASM_FILES = {
  'ghostty-vt.wasm': 'ghostty-web',
  'ghostty-vt-small.wasm': 'ghostty-vt',
} as const;

export type GhosttyWasmFile = keyof typeof GHOSTTY_WASM_FILES;

/**
 * Locates a served wasm file, preferring the copy the build puts in `dist/` (npm install)
 * over the vendored source copy (local dev). Exits the process if neither exists.
 *
 * @param file - The wasm file name; defaults to the Coder engine's `ghostty-vt.wasm`.
 * @returns The absolute path to the wasm file.
 * @throws Exits the process with code 1 if the wasm cannot be found.
 */
export function findGhosttyWasm(file: GhosttyWasmFile = 'ghostty-vt.wasm'): string {
  const projectRoot = path.join(__dirname, '..', '..');
  const candidates = [
    path.join(projectRoot, 'dist', file),
    path.join(projectRoot, 'src', 'client', 'vendor', GHOSTTY_WASM_FILES[file], file),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  console.error(`Error: Could not find ${file}.`);
  process.exit(1);
}

/**
 * Locates every file in {@link GHOSTTY_WASM_FILES}, keyed by the URL path it is served at.
 *
 * @returns A map from `/<file>` to the absolute path {@link findGhosttyWasm} resolves.
 * @throws Exits the process with code 1 if any wasm cannot be found.
 */
export function findGhosttyWasms(): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const file of Object.keys(GHOSTTY_WASM_FILES) as GhosttyWasmFile[]) {
    paths[`/${file}`] = findGhosttyWasm(file);
  }
  return paths;
}

/**
 * Reads `filePath` from disk and writes it to `res` with the correct Content-Type header.
 * Responds with 404 if the file cannot be read.
 *
 * @param filePath - The file path to serve.
 * @param res - The HTTP response object.
 */
export function serveFile(filePath: string, res: http.ServerResponse): void {
  const contentType = mimeType(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}
