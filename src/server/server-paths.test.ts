import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  findClientRoot,
  findWasm,
  MissingWasmError,
  projectRootOf,
  resolveServerPaths,
} from './server-paths';

const ROOT = path.resolve('/pkg');
const BUILT_WASM = path.join(ROOT, 'dist', 'ghostty-vt-small.wasm');
const VENDORED_WASM = path.join(
  ROOT,
  'src',
  'client',
  'vendor',
  'ghostty-vt',
  'ghostty-vt-small.wasm',
);
const BUILT_HTML = path.join(ROOT, 'dist', 'client.html');

/** An existsSync that sees only `files`, and records every path it was asked about. */
function fakeFs(...files: string[]) {
  const asked: string[] = [];
  const existsSync = (p: string) => {
    asked.push(p);
    return files.includes(p);
  };
  return { existsSync, asked };
}

describe('projectRootOf', () => {
  test.each([
    ['src/server (dev checkout)', path.join(ROOT, 'src', 'server')],
    ['dist/server (bundled entry)', path.join(ROOT, 'dist', 'server')],
  ])('is two levels above %s', (_layout, moduleDir) => {
    expect(projectRootOf(moduleDir)).toBe(ROOT);
  });
});

describe('findWasm', () => {
  test('prefers the wasm copied into dist/ by the build', () => {
    const { existsSync, asked } = fakeFs(BUILT_WASM, VENDORED_WASM);
    expect(findWasm(ROOT, existsSync)).toBe(BUILT_WASM);
    expect(asked).toEqual([BUILT_WASM]);
  });

  test('falls back to the vendored wasm when dist/ has none', () => {
    const { existsSync, asked } = fakeFs(VENDORED_WASM);
    expect(findWasm(ROOT, existsSync)).toBe(VENDORED_WASM);
    expect(asked).toEqual([BUILT_WASM, VENDORED_WASM]);
  });

  test('throws naming the missing file when neither exists', () => {
    const { existsSync } = fakeFs();
    expect(() => findWasm(ROOT, existsSync)).toThrow(MissingWasmError);
    expect(() => findWasm(ROOT, existsSync)).toThrow('Could not find ghostty-vt-small.wasm.');
  });
});

describe('findClientRoot', () => {
  test('is dist/ once the build has put client.html there', () => {
    expect(findClientRoot(ROOT, fakeFs(BUILT_HTML).existsSync)).toBe(path.join(ROOT, 'dist'));
  });

  test('is src/client/ in a checkout that has not been built', () => {
    expect(findClientRoot(ROOT, fakeFs().existsSync)).toBe(path.join(ROOT, 'src', 'client'));
  });
});

describe('resolveServerPaths', () => {
  test('the built layout: dist/server/index.js with everything in dist/', () => {
    const { existsSync } = fakeFs(BUILT_WASM, BUILT_HTML);
    expect(resolveServerPaths(path.join(ROOT, 'dist', 'server'), existsSync)).toEqual({
      projectRoot: ROOT,
      clientRoot: path.join(ROOT, 'dist'),
      wasmPath: BUILT_WASM,
    });
  });

  test('the source layout: src/server/index.ts with the vendored wasm and src/client', () => {
    const { existsSync } = fakeFs(VENDORED_WASM);
    expect(resolveServerPaths(path.join(ROOT, 'src', 'server'), existsSync)).toEqual({
      projectRoot: ROOT,
      clientRoot: path.join(ROOT, 'src', 'client'),
      wasmPath: VENDORED_WASM,
    });
  });

  test('throws MissingWasmError when the wasm is in neither place', () => {
    expect(() => resolveServerPaths(path.join(ROOT, 'src', 'server'), fakeFs().existsSync)).toThrow(
      MissingWasmError,
    );
  });

  test('defaults to this checkout, whose vendored wasm is committed', () => {
    const paths = resolveServerPaths();
    expect(paths.projectRoot).toBe(path.resolve(import.meta.dir, '..', '..'));
    expect(fs.existsSync(paths.wasmPath)).toBe(true);
    expect(fs.existsSync(path.join(paths.clientRoot, 'client.html'))).toBe(true);
  });
});
