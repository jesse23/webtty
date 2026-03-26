import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

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

// Copy ghostty-web assets into dist/ so they ship with the package.
// Without this, `npx webtty` fails — the package is extracted to a temp
// directory with no node_modules, so require.resolve('ghostty-web') throws.
const ghosttyWebMain = require.resolve('ghostty-web') as string;
const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, '');
fs.copyFileSync(
  path.join(ghosttyWebRoot, 'dist', 'ghostty-web.js'),
  path.resolve('./dist/ghostty-web.js'),
);
fs.copyFileSync(
  path.join(ghosttyWebRoot, 'ghostty-vt.wasm'),
  path.resolve('./dist/ghostty-vt.wasm'),
);

const totalFiles = serverResult.outputs.length + clientResult.outputs.length + 4;
console.log(`✓ Build complete (${totalFiles} files)`);
