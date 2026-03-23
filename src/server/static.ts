import fs from 'node:fs';
import type http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghosttyWebRootFromMain, mimeType } from '../utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

export function findGhosttyWeb(): { distPath: string; wasmPath: string } {
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
