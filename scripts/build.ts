#!/usr/bin/env bun

import { Glob } from 'bun';

const entrypoints: string[] = [];
const glob = new Glob('**/*.ts');

for await (const file of glob.scan('./src')) {
  if (!file.endsWith('.d.ts') && !file.endsWith('.test.ts')) {
    entrypoints.push(`./src/${file}`);
  }
}

const result = await Bun.build({
  entrypoints,
  outdir: './dist',
  root: './src',
  format: 'esm',
  sourcemap: 'external',
  external: ['./*', '../*'],
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`✓ Build complete (${result.outputs.length} files)`);
