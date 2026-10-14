import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from './minisign';
import { type PinnedRelease, type Sidecar, verifyPinned, WASM_FILE, writePin } from './sidecar';
import { createMinisignSigner } from './test-support/minisign-signer';

const signer = createMinisignSigner();
const BYTES = new TextEncoder().encode('not really wasm');
const COMMENT = `timestamp:1\tfile:${WASM_FILE}\thashed`;

function pin(
  overrides: Partial<Sidecar> = {},
  minisig = signer.sign(BYTES, COMMENT),
): PinnedRelease {
  return {
    bytes: BYTES,
    minisig,
    license: new TextEncoder().encode('MIT License\n'),
    sidecar: {
      file: WASM_FILE,
      size: BYTES.byteLength,
      sha256: sha256(BYTES),
      minisig: `${WASM_FILE}.minisig`,
      publicKey: signer.publicKey,
      ...overrides,
    } as Sidecar,
  };
}

let dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-pin-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('writePin', () => {
  test('writes the wasm, signature, licence and a pretty sidecar with a final newline', () => {
    const dir = path.join(tmpDir(), 'nested', 'ghostty-vt');
    const written = pin();
    writePin(dir, written);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'LICENSE',
      WASM_FILE,
      `${WASM_FILE}.json`,
      `${WASM_FILE}.minisig`,
    ]);
    expect(new Uint8Array(fs.readFileSync(path.join(dir, WASM_FILE)))).toEqual(BYTES);
    expect(fs.readFileSync(path.join(dir, `${WASM_FILE}.json`), 'utf8')).toBe(
      `${JSON.stringify(written.sidecar, null, 2)}\n`,
    );
  });
});

describe('verifyPinned', () => {
  test('returns the sidecar and the signature of a good pin', () => {
    const dir = tmpDir();
    writePin(dir, pin());
    const { sidecar, sig } = verifyPinned(dir, signer.publicKey);
    expect(sidecar.sha256).toBe(sha256(BYTES));
    expect(sig.file).toBe(WASM_FILE);
  });

  test.each([
    ['a size that does not match', pin({ size: 1 }), `${WASM_FILE}: size 15 != sidecar 1`],
    [
      'a sha256 that does not match',
      pin({ sha256: 'beef' }),
      `sha256 ${sha256(BYTES)} != sidecar beef`,
    ],
    [
      'a signature for another file',
      pin({}, signer.sign(BYTES, 'timestamp:1\tfile:other.wasm')),
      `signature is for other.wasm, not ${WASM_FILE}`,
    ],
    [
      'a signature over other bytes',
      pin({}, signer.sign(new Uint8Array([1]), COMMENT)),
      'minisign: file signature is invalid',
    ],
  ])('rejects %s', (_name, written, message) => {
    const dir = tmpDir();
    writePin(dir, written);
    expect(() => verifyPinned(dir, signer.publicKey)).toThrow(message);
  });

  test('rejects a missing sidecar', () => {
    expect(() => verifyPinned(tmpDir(), signer.publicKey)).toThrow('ENOENT');
  });
});
