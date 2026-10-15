// Minisign signature verification over node:crypto, used to check that Ghostty's CI signed
// the vendored wasm (pure util, ADR 042, ADR 059). The format is minisign's: an untrusted
// comment, the signature line, the trusted comment and the global signature over it.

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

/** What a verified signature says about itself; recorded in the sidecar. */
export interface MinisigResult {
  /** Key id as minisign prints it (big-endian hex). */
  keyId: string;
  /** `ED`: signature over BLAKE2b-512 of the file; `Ed`: over the file itself. */
  algorithm: 'Ed' | 'ED';
  trustedComment: string;
  timestamp?: number;
  file?: string;
}

/** The parsed fields of a `.minisig` file, before any signature is checked. */
interface MinisigFile {
  algorithm: 'Ed' | 'ED';
  keyId: Buffer;
  sigBytes: Buffer;
  trustedComment: string;
  globalSig: Buffer;
}

/** The hex sha256 of `bytes`, as the sidecar and the build record it. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const hexId = (b: Uint8Array) => Buffer.from(b).reverse().toString('hex').toUpperCase();

function parseMinisig(minisigText: string): MinisigFile {
  const lines = minisigText.replace(/\r/g, '').split('\n');
  if (!lines[0]?.startsWith('untrusted comment:')) {
    throw new Error('minisign: missing untrusted comment');
  }
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  if (sig.length !== 74) throw new Error(`minisign: signature is ${sig.length} bytes, want 74`);
  const algorithm = sig.toString('latin1', 0, 2);
  if (algorithm !== 'Ed' && algorithm !== 'ED') {
    throw new Error(`minisign: unknown algorithm ${algorithm}`);
  }
  const tcPrefix = 'trusted comment: ';
  if (!lines[2]?.startsWith(tcPrefix)) throw new Error('minisign: missing trusted comment');
  const trustedComment = lines[2].slice(tcPrefix.length);
  const globalSig = Buffer.from(lines[3] ?? '', 'base64');
  if (globalSig.length !== 64) throw new Error('minisign: bad global signature');
  return {
    algorithm,
    keyId: sig.subarray(2, 10),
    sigBytes: sig.subarray(10, 74),
    trustedComment,
    globalSig,
  };
}

/**
 * Verifies a minisign signature over `data`: the Ed25519 signature (over BLAKE2b-512 of the
 * data for `ED`) and the global signature over the trusted comment, both against `publicKey`.
 *
 * @throws If the signature, its key id or its trusted comment does not verify.
 */
export function verifyMinisign(
  data: Uint8Array,
  minisigText: string,
  publicKey: string,
): MinisigResult {
  const pk = Buffer.from(publicKey, 'base64');
  if (pk.length !== 42 || pk.toString('latin1', 0, 2) !== 'Ed') {
    throw new Error('minisign: bad public key');
  }
  const pkKeyId = pk.subarray(2, 10);
  const { algorithm, keyId, sigBytes, trustedComment, globalSig } = parseMinisig(minisigText);
  if (!keyId.equals(pkKeyId)) {
    throw new Error(`minisign: signed by key ${hexId(keyId)}, expected ${hexId(pkKeyId)}`);
  }
  // Raw Ed25519 key in an SPKI DER wrapper for node:crypto.
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pk.subarray(10, 42)]),
    format: 'der',
    type: 'spki',
  });
  const message =
    algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : Buffer.from(data);
  if (!edVerify(null, message, key, sigBytes)) {
    throw new Error('minisign: file signature is invalid');
  }
  const signedComment = Buffer.concat([sigBytes, Buffer.from(trustedComment, 'utf8')]);
  if (!edVerify(null, signedComment, key, globalSig)) {
    throw new Error('minisign: trusted comment signature is invalid');
  }
  const ts = /timestamp:(\d+)/.exec(trustedComment)?.[1];
  return {
    keyId: hexId(keyId),
    algorithm,
    trustedComment,
    timestamp: ts ? Number(ts) : undefined,
    file: /file:([^\t]+)/.exec(trustedComment)?.[1],
  };
}
