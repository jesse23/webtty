import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GHOSTTY_MINISIGN_PUBKEY,
  type Sidecar,
  verifyMinisign,
  verifyPinned,
} from '../../../../scripts/update-ghostty-vt';

const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../ghostty-vt');

// Ghostty's minisign release key, copied from Ghostty's PACKAGING.md (ADR 042). Kept here
// rather than imported so a changed key in the script or the sidecar fails this test.
const GHOSTTY_PUBLIC_KEY = 'RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV';
const GHOSTTY_KEY_ID = 'F5787DDB42320225';

describe('vendored official ghostty-vt-small.wasm', () => {
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(VENDOR_DIR, 'ghostty-vt-small.wasm.json'), 'utf8'),
  ) as Sidecar;
  const wasm = new Uint8Array(fs.readFileSync(path.join(VENDOR_DIR, sidecar.file)));
  const minisig = fs.readFileSync(path.join(VENDOR_DIR, sidecar.minisig), 'utf8');

  test('is the ReleaseSmall build the sidecar names', () => {
    expect(sidecar.file).toBe('ghostty-vt-small.wasm');
    expect(sidecar.variant).toBe('ReleaseSmall');
    expect(sidecar.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sidecar.url).toBe(`https://tip.files.ghostty.org/${sidecar.commit}/${sidecar.file}`);
  });

  test('matches the size recorded in its sidecar', () => {
    expect(wasm.byteLength).toBe(sidecar.size);
  });

  test('matches the sha256 recorded in its sidecar', () => {
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(sidecar.sha256);
  });

  test("update script pins Ghostty's release key", () => {
    expect(GHOSTTY_MINISIGN_PUBKEY).toBe(GHOSTTY_PUBLIC_KEY);
  });

  test("sidecar records Ghostty's release key", () => {
    expect(sidecar.publicKey).toBe(GHOSTTY_PUBLIC_KEY);
    expect(sidecar.signature.keyId).toBe(GHOSTTY_KEY_ID);
  });

  test("is signed by Ghostty's release key", () => {
    const sig = verifyMinisign(wasm, minisig, GHOSTTY_PUBLIC_KEY);
    expect(sig.keyId).toBe(GHOSTTY_KEY_ID);
    expect(sig.algorithm).toBe('ED');
    expect(sig.file).toBe(sidecar.file);
    expect(sig.trustedComment).toBe(sidecar.signature.trustedComment);
  });

  test('passes the same offline check as `update-ghostty-vt.ts --verify`', () => {
    expect(() => verifyPinned(VENDOR_DIR, GHOSTTY_PUBLIC_KEY)).not.toThrow();
  });

  test('ships with the Ghostty MIT licence', () => {
    const license = fs.readFileSync(path.join(VENDOR_DIR, 'LICENSE'), 'utf8');
    expect(license).toStartWith('MIT License');
    expect(license).toContain('Mitchell Hashimoto, Ghostty contributors');
  });
});

describe('verifyMinisign rejects', () => {
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(VENDOR_DIR, 'ghostty-vt-small.wasm.json'), 'utf8'),
  ) as Sidecar;
  const wasm = new Uint8Array(fs.readFileSync(path.join(VENDOR_DIR, sidecar.file)));
  const minisig = fs.readFileSync(path.join(VENDOR_DIR, sidecar.minisig), 'utf8');

  test('a wasm with one byte changed', () => {
    const tampered = wasm.slice();
    tampered[tampered.length >> 1] = (tampered[tampered.length >> 1] as number) ^ 1;
    expect(() => verifyMinisign(tampered, minisig, GHOSTTY_PUBLIC_KEY)).toThrow(
      'file signature is invalid',
    );
  });

  test('an edited trusted comment', () => {
    const edited = minisig.replace('file:ghostty-vt-small.wasm', 'file:ghostty-vt.wasm');
    expect(edited).not.toBe(minisig);
    expect(() => verifyMinisign(wasm, edited, GHOSTTY_PUBLIC_KEY)).toThrow(
      'trusted comment signature is invalid',
    );
  });

  test('a signature checked against a different key', () => {
    // Same key id, different Ed25519 key: the id check passes, the signature must not.
    const pk = Buffer.from(GHOSTTY_PUBLIC_KEY, 'base64');
    pk[20] = (pk[20] as number) ^ 1;
    expect(() => verifyMinisign(wasm, minisig, pk.toString('base64'))).toThrow();
  });

  test('a signature from another key id', () => {
    const pk = Buffer.from(GHOSTTY_PUBLIC_KEY, 'base64');
    pk[2] = (pk[2] as number) ^ 1;
    expect(() => verifyMinisign(wasm, minisig, pk.toString('base64'))).toThrow('signed by key');
  });
});
