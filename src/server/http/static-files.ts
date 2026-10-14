// Static files for the HTTP server: MIME types, the wasm's file name and serveFile (ADR 062).
// A small service module; where the files are on disk is server-paths.ts's job.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

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
