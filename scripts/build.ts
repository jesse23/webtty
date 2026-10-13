import fs from 'node:fs';
import path from 'node:path';

const serverResult = await Bun.build({
  entrypoints: ['./src/server/index.ts', './src/cli/index.ts'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  sourcemap: 'external',
  external: ['@lydell/node-pty', 'ws'],
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
  naming: 'client-browser.js',
});

if (!clientResult.success) {
  console.error('Client build failed:');
  for (const log of clientResult.logs) console.error(log);
  process.exit(1);
}

fs.copyFileSync(path.resolve('./src/client/client.html'), path.resolve('./dist/client.html'));
fs.copyFileSync(path.resolve('./src/client/index.css'), path.resolve('./dist/client.css'));

// The vendored ghostty-web TypeScript is bundled into client-browser.js; its wasm
// ships next to it in dist/ so the published package needs nothing outside dist/.
fs.copyFileSync(
  path.resolve('./src/client/vendor/ghostty-web/ghostty-vt.wasm'),
  path.resolve('./dist/ghostty-vt.wasm'),
);

// The vendored TS has no licence headers, so nothing survives minification; the
// MIT notices for the code in client-browser.js and ghostty-vt.wasm ship here instead.
const vendorDir = './src/client/vendor/ghostty-web';
fs.writeFileSync(
  path.resolve('./dist/THIRD_PARTY_LICENSES'),
  [
    'ghostty-web (bundled in client-browser.js; ghostty-vt.wasm build and patch)',
    'https://github.com/coder/ghostty-web',
    '',
    fs.readFileSync(path.resolve(vendorDir, 'LICENSE'), 'utf8').trim(),
    '',
    '---',
    '',
    'Ghostty (compiled into ghostty-vt.wasm)',
    'https://github.com/ghostty-org/ghostty',
    '',
    fs.readFileSync(path.resolve(vendorDir, 'LICENSE.ghostty'), 'utf8').trim(),
    '',
  ].join('\n'),
);

const totalFiles = serverResult.outputs.length + clientResult.outputs.length + 4;
console.log(`✓ Build complete (${totalFiles} files)`);
