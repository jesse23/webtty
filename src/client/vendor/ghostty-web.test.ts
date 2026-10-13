import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ghostty-web');

describe('vendored ghostty-vt.wasm', () => {
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(VENDOR_DIR, 'ghostty-vt.wasm.json'), 'utf8'),
  ) as { file: string; size: number; sha256: string };
  const wasm = fs.readFileSync(path.join(VENDOR_DIR, sidecar.file));

  test('matches the size recorded in its sidecar', () => {
    expect(wasm.byteLength).toBe(sidecar.size);
  });

  test('matches the sha256 recorded in its sidecar', () => {
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(sidecar.sha256);
  });
});
