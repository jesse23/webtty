#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';

const serverResult = await Bun.build({
  entrypoints: ['./src/server/index.ts', './src/cli/index.ts'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  sourcemap: 'external',
  external: ['@lydell/node-pty', 'ws', 'ghostty-web'],
  banner: '#!/usr/bin/env node\n',
});

if (!serverResult.success) {
  console.error('Server build failed:');
  for (const log of serverResult.logs) console.error(log);
  process.exit(1);
}

const clientResult = await Bun.build({
  entrypoints: ['./src/client/index.ts'],
  outdir: './dist',
  target: 'browser',
  format: 'esm',
  minify: true,
  external: ['ghostty-web'],
  naming: 'client-browser.js',
});

if (!clientResult.success) {
  console.error('Client build failed:');
  for (const log of clientResult.logs) console.error(log);
  process.exit(1);
}

const clientOut = path.resolve('./dist/client-browser.js');
const clientJs = fs.readFileSync(clientOut, 'utf8');
fs.writeFileSync(clientOut, clientJs.replace(/"ghostty-web"/g, '"/dist/ghostty-web.js"'));

fs.copyFileSync(path.resolve('./src/client/client.html'), path.resolve('./dist/client.html'));
fs.copyFileSync(path.resolve('./src/client/index.css'), path.resolve('./dist/client.css'));

const totalFiles = serverResult.outputs.length + clientResult.outputs.length + 2;
console.log(`✓ Build complete (${totalFiles} files)`);
