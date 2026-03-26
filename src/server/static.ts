import fs from 'node:fs';
import type http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

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

export function mimeType(filePath: string): string {
  const ext = path.extname(filePath);
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function ghosttyWebRootFromMain(mainPath: string): string {
  return mainPath.replace(/[/\\]dist[/\\].*$/, '');
}

export function findGhosttyWeb(): { distPath: string; wasmPath: string } {
  // Prefer assets bundled into dist/ — present when installed via npx/npm.
  const bundledDist = path.join(__dirname, '..', '..', 'dist');
  const bundledWasm = path.join(bundledDist, 'ghostty-vt.wasm');
  if (fs.existsSync(path.join(bundledDist, 'ghostty-web.js')) && fs.existsSync(bundledWasm)) {
    return { distPath: bundledDist, wasmPath: bundledWasm };
  }

  // Fall back to node_modules — present during local development.
  try {
    const ghosttyWebMain = require.resolve('ghostty-web') as string;
    const ghosttyWebRoot = ghosttyWebRootFromMain(ghosttyWebMain);
    const distPath = path.join(ghosttyWebRoot, 'dist');
    const wasmPath = path.join(ghosttyWebRoot, 'ghostty-vt.wasm');
    if (fs.existsSync(path.join(distPath, 'ghostty-web.js')) && fs.existsSync(wasmPath)) {
      return { distPath, wasmPath };
    }
  } catch {
    // fall through
  }
  console.error('Error: Could not find ghostty-web package.');
  process.exit(1);
}

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
