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

/** The wasm the client loads: Ghostty's official libghostty-vt (ADR 042, ADR 047). */
export const GHOSTTY_WASM = 'ghostty-vt-small.wasm';

/**
 * Locates {@link GHOSTTY_WASM}, preferring the copy the build puts in `dist/` (npm install)
 * over the vendored source copy (local dev). Exits the process if neither exists.
 *
 * @returns The absolute path to the wasm file.
 * @throws Exits the process with code 1 if the wasm cannot be found.
 */
export function findGhosttyWasm(): string {
  const projectRoot = path.join(__dirname, '..', '..');
  const candidates = [
    path.join(projectRoot, 'dist', GHOSTTY_WASM),
    path.join(projectRoot, 'src', 'client', 'vendor', 'ghostty-vt', GHOSTTY_WASM),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  console.error(`Error: Could not find ${GHOSTTY_WASM}.`);
  process.exit(1);
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
