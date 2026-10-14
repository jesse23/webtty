// A throwaway minisign key that signs like `minisign -S` (test fake, ADR 064), so the
// verifier's branches and a pin with another file name or build are tested without
// Ghostty's private key.

import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

/** A generated Ed25519 key with its minisign public key string and key id. */
export interface MinisignSigner {
  /** The public key as minisign prints it: base64 of `Ed`, the key id and the raw key. */
  publicKey: string;
  /** Eight key id bytes, little-endian as they sit in the key and the signature. */
  keyId: Buffer;
  /** Signs `data` and returns the `.minisig` text with `trustedComment`. */
  sign(data: Uint8Array, trustedComment: string, algorithm?: 'Ed' | 'ED'): string;
}

function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

/** Generates a fresh signer; `keyId` defaults to eight bytes counting up from 1. */
export function createMinisignSigner(
  keyId = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
): MinisignSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pk = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, rawPublicKey(publicKey)]);
  return {
    publicKey: pk.toString('base64'),
    keyId,
    sign(data, trustedComment, algorithm = 'ED') {
      const message =
        algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : Buffer.from(data);
      const sigBytes = sign(null, message, privateKey);
      const global = sign(
        null,
        Buffer.concat([sigBytes, Buffer.from(trustedComment, 'utf8')]),
        privateKey,
      );
      const sig = Buffer.concat([Buffer.from(algorithm, 'latin1'), keyId, sigBytes]);
      return [
        'untrusted comment: signature from a test key',
        sig.toString('base64'),
        `trusted comment: ${trustedComment}`,
        global.toString('base64'),
        '',
      ].join('\n');
    },
  };
}
