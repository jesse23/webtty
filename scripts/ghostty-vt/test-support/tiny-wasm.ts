// A hand-assembled wasm module with the exports the binding needs (test fake, ADR 064):
// every function returns one constant, so `ghostty_build_info` can succeed with an empty
// Debug build or fail with a nonzero code, without the real libghostty-vt.

import { REQUIRED_EXPORTS } from '../inspect-wasm';

const MAGIC_AND_VERSION = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const FUNC = 0x00;
const TABLE = 0x01;
const MEMORY = 0x02;

function section(id: number, body: number[]): number[] {
  return [id, body.length, ...body];
}

function exportEntry(name: string): number[] {
  const kind = name === 'memory' ? MEMORY : name === '__indirect_function_table' ? TABLE : FUNC;
  const bytes = [...Buffer.from(name, 'utf8')];
  return [bytes.length, ...bytes, kind, 0];
}

/**
 * A module whose one function, `(i32, i32) -> i32`, returns `result` (0..63), exported
 * under every required function name, with a one-page memory and an empty table.
 */
export function tinyWasm(result: number): Uint8Array<ArrayBuffer> {
  const exports = REQUIRED_EXPORTS.flatMap(exportEntry);
  const exportBody = [REQUIRED_EXPORTS.length, ...exports];
  const bytes = [
    ...MAGIC_AND_VERSION,
    ...section(1, [1, 0x60, 2, 0x7f, 0x7f, 1, 0x7f]),
    ...section(3, [1, 0]),
    ...section(4, [1, 0x70, 0, 0]),
    ...section(5, [1, 0, 1]),
    // The export section is over 127 bytes, so its size is a two-byte LEB128.
    7,
    (exportBody.length & 0x7f) | 0x80,
    exportBody.length >> 7,
    ...exportBody,
    ...section(10, [1, 4, 0, 0x41, result, 0x0b]),
  ];
  return new Uint8Array(bytes);
}

/** The smallest valid module: no exports at all. */
export const EMPTY_WASM = new Uint8Array([...MAGIC_AND_VERSION]);

/** A module with one imported function, `env.f`, and no exports. */
export const IMPORTING_WASM = new Uint8Array([
  ...MAGIC_AND_VERSION,
  ...section(1, [1, 0x60, 0, 0]),
  ...section(2, [1, 3, ...Buffer.from('env'), 1, ...Buffer.from('f'), FUNC, 0]),
]);
