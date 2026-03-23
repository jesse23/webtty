#!/usr/bin/env bun

export {};

const result = await Bun.build({
  entrypoints: ['./src/server/index.ts', './src/cli/index.ts'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  sourcemap: 'external',
  external: ['@lydell/node-pty', 'ws', 'ghostty-web'],
  banner: '#!/usr/bin/env node\n',
});

if (!result.success) {
  console.error('Build failed:');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`✓ Build complete (${result.outputs.length} files)`);
