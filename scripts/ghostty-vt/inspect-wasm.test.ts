import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { VENDOR_DIR } from '../update-ghostty-vt';
import { inspectWasm } from './inspect-wasm';
import type { Sidecar } from './sidecar';
import { EMPTY_WASM, tinyWasm } from './test-support/tiny-wasm';

describe('inspectWasm', () => {
  test('reads the vendored wasm as its sidecar records it, offline', async () => {
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(VENDOR_DIR, 'ghostty-vt-small.wasm.json'), 'utf8'),
    ) as Sidecar;
    const bytes = new Uint8Array(fs.readFileSync(path.join(VENDOR_DIR, sidecar.file)));
    expect(await inspectWasm(bytes)).toEqual(sidecar.wasm);
  });

  test('reports the build info of a module with every required export', async () => {
    const info = await inspectWasm(tinyWasm(0));
    expect(info.exportCount).toBe(14);
    expect(info.functionExports).toBe(12);
    expect(info.nonFunctionExports).toEqual(['memory:memory', '__indirect_function_table:table']);
    expect(info.imports).toEqual([]);
    expect(info.initialMemoryBytes).toBe(65536);
    expect(info.buildInfo).toEqual({
      version: '',
      versionBuild: '',
      optimize: 'Debug',
      simd: false,
      kittyGraphics: false,
      tmuxControlMode: false,
    });
  });

  test.each([
    ['bytes that are not wasm', new Uint8Array([1, 2, 3]), 'wasm: WebAssembly.validate failed'],
    ['a module without the exports', EMPTY_WASM, 'wasm: missing exports memory, __indirect'],
    ['a failing ghostty_build_info', tinyWasm(1), 'wasm: ghostty_build_info(4) returned 1'],
  ])('rejects %s', async (_name, bytes, message) => {
    await expect(inspectWasm(bytes)).rejects.toThrow(message);
  });
});
