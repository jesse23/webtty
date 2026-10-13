import { describe, expect, test } from 'bun:test';
import { DEFAULT_ENGINE, engineWasmPath, selectEngine } from './engine';

describe('selectEngine', () => {
  test('defaults to the Coder engine until ADR 042 flips it', () => {
    expect(DEFAULT_ENGINE).toBe('coder');
    expect(selectEngine('')).toBe(DEFAULT_ENGINE);
  });

  test('?engine=official and ?engine=coder override the default', () => {
    expect(selectEngine('?engine=official')).toBe('official');
    expect(selectEngine('?engine=coder')).toBe('coder');
    expect(selectEngine('?foo=1&engine=official')).toBe('official');
  });

  test('any other value uses the default', () => {
    expect(selectEngine('?engine=')).toBe(DEFAULT_ENGINE);
    expect(selectEngine('?engine=Official')).toBe(DEFAULT_ENGINE);
    expect(selectEngine('?engine=ghostty')).toBe(DEFAULT_ENGINE);
  });
});

describe('engineWasmPath', () => {
  test('each engine loads the wasm the server serves for it', () => {
    expect(engineWasmPath('coder')).toBe('/ghostty-vt.wasm');
    expect(engineWasmPath('official')).toBe('/ghostty-vt-small.wasm');
  });
});
