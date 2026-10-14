import { describe, expect, test } from 'bun:test';
import { sha256, verifyMinisign } from './minisign';
import { createMinisignSigner } from './test-support/minisign-signer';

const DATA = new TextEncoder().encode('ghostty');
const COMMENT = 'timestamp:1700000000\tfile:ghostty-vt-small.wasm\thashed';
const signer = createMinisignSigner();
const minisig = signer.sign(DATA, COMMENT);
const lines = minisig.split('\n');
const withLine = (index: number, text: string) =>
  lines.map((line, i) => (i === index ? text : line)).join('\n');
const b64 = (...parts: Buffer[]) => Buffer.concat(parts).toString('base64');

describe('sha256', () => {
  test('is the lowercase hex digest', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('verifyMinisign accepts', () => {
  test('a prehashed (ED) signature and reads the trusted comment', () => {
    expect(verifyMinisign(DATA, minisig, signer.publicKey)).toEqual({
      keyId: '0807060504030201',
      algorithm: 'ED',
      trustedComment: COMMENT,
      timestamp: 1700000000,
      file: 'ghostty-vt-small.wasm',
    });
  });

  test('a legacy (Ed) signature over the data itself', () => {
    expect(verifyMinisign(DATA, signer.sign(DATA, COMMENT, 'Ed'), signer.publicKey).algorithm).toBe(
      'Ed',
    );
  });

  test('CRLF line endings and a comment without timestamp or file', () => {
    const sig = signer.sign(DATA, 'no fields').replace(/\n/g, '\r\n');
    const result = verifyMinisign(DATA, sig, signer.publicKey);
    expect(result.timestamp).toBeUndefined();
    expect(result.file).toBeUndefined();
  });
});

describe('verifyMinisign rejects', () => {
  const pk = Buffer.from(signer.publicKey, 'base64');
  const sig = Buffer.from(lines[1] as string, 'base64');
  const other = createMinisignSigner(Buffer.from([9, 9, 9, 9, 9, 9, 9, 9]));

  test.each([
    ['a short public key', minisig, pk.subarray(0, 41).toString('base64'), 'bad public key'],
    [
      'a public key of another algorithm',
      minisig,
      b64(Buffer.from('XX'), pk.subarray(2)),
      'bad public key',
    ],
    [
      'a missing untrusted comment',
      withLine(0, 'comment'),
      signer.publicKey,
      'missing untrusted comment',
    ],
    [
      'a short signature',
      withLine(1, sig.subarray(0, 70).toString('base64')),
      signer.publicKey,
      'signature is 70 bytes, want 74',
    ],
    [
      'an unknown algorithm',
      withLine(1, b64(Buffer.from('Xx'), sig.subarray(2))),
      signer.publicKey,
      'unknown algorithm Xx',
    ],
    [
      'a missing trusted comment',
      withLine(2, 'comment'),
      signer.publicKey,
      'missing trusted comment',
    ],
    ['a short global signature', withLine(3, 'AAAA'), signer.publicKey, 'bad global signature'],
    [
      'another key id',
      minisig,
      other.publicKey,
      'signed by key 0807060504030201, expected 0909090909090909',
    ],
    [
      'a signature from another key with the same id',
      createMinisignSigner().sign(DATA, COMMENT),
      signer.publicKey,
      'file signature is invalid',
    ],
    [
      'an edited trusted comment',
      withLine(2, 'trusted comment: edited'),
      signer.publicKey,
      'trusted comment signature is invalid',
    ],
  ])('%s', (_name, text, key, message) => {
    expect(() => verifyMinisign(DATA, text, key)).toThrow(message);
  });

  test('changed data', () => {
    expect(() =>
      verifyMinisign(new TextEncoder().encode('ghostty!'), minisig, signer.publicKey),
    ).toThrow('file signature is invalid');
  });
});
