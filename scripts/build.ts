import { createHash } from 'node:crypto';
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

// The vendored ghostty-web TypeScript is bundled into client-browser.js; the official
// libghostty-vt wasm it runs (ADR 042, ADR 047) ships next to it in dist/ so the
// published package needs nothing outside dist/. Nothing is fetched: the committed
// wasm is copied only if it matches its sidecar's size and sha256.
const officialDir = './src/client/vendor/ghostty-vt';
const officialSidecar = JSON.parse(
  fs.readFileSync(path.resolve(officialDir, 'ghostty-vt-small.wasm.json'), 'utf8'),
) as { file: string; size: number; sha256: string };
const officialWasm = fs.readFileSync(path.resolve(officialDir, officialSidecar.file));
const officialSha256 = createHash('sha256').update(officialWasm).digest('hex');
if (officialWasm.byteLength !== officialSidecar.size || officialSha256 !== officialSidecar.sha256) {
  console.error(
    `${officialDir}/${officialSidecar.file} does not match its sidecar: ` +
      `${officialWasm.byteLength} bytes, sha256 ${officialSha256}; ` +
      `expected ${officialSidecar.size} bytes, sha256 ${officialSidecar.sha256}`,
  );
  process.exit(1);
}
fs.writeFileSync(path.resolve('./dist', officialSidecar.file), officialWasm);

// The vendored TS has no licence headers, so nothing survives minification; the
// MIT notices for the code in client-browser.js and the wasm ship here instead.
const vendorDir = './src/client/vendor/ghostty-web';
fs.writeFileSync(
  path.resolve('./dist/THIRD_PARTY_LICENSES'),
  [
    'ghostty-web (TypeScript bundled in client-browser.js)',
    'https://github.com/coder/ghostty-web',
    '',
    fs.readFileSync(path.resolve(vendorDir, 'LICENSE'), 'utf8').trim(),
    '',
    '---',
    '',
    `Ghostty libghostty-vt (${officialSidecar.file}, unmodified official build)`,
    'https://github.com/ghostty-org/ghostty',
    '',
    fs.readFileSync(path.resolve(officialDir, 'LICENSE'), 'utf8').trim(),
    '',
    '---',
    '',
    'ghostty-vt-js (fn-table.ts, bundled in client-browser.js)',
    'https://github.com/gkoreli/ghostty-vt-js',
    '',
    fs.readFileSync(path.resolve(vendorDir, 'LICENSE.ghostty-vt-js'), 'utf8').trim(),
    '',
  ].join('\n'),
);

const totalFiles = serverResult.outputs.length + clientResult.outputs.length + 4;
console.log(`✓ Build complete (${totalFiles} files)`);
