// The pin record of the vendored libghostty-vt wasm: its constants, the JSON sidecar
// written next to it, and reading, re-verifying and writing a pin on disk (service over
// node:fs, ADR 041, ADR 042, ADR 059).

import fs from 'node:fs';
import path from 'node:path';
import type { WasmInfo } from './inspect-wasm';
import { type MinisigResult, sha256, verifyMinisign } from './minisign';

/** Ghostty's minisign release key, from Ghostty's PACKAGING.md. */
export const GHOSTTY_MINISIGN_PUBKEY = 'RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV';
/** The vendored wasm's file name; the build copies it under the same name. */
export const WASM_FILE = 'ghostty-vt-small.wasm';
/** The sidecar's licence line for the vendored `LICENSE`. */
export const LICENSE_NOTE =
  'MIT (Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors; LICENSE)';

/** The JSON sidecar written next to the wasm. */
export interface Sidecar {
  repo: string;
  commit: string;
  commitDate?: string;
  url: string;
  file: string;
  variant: 'ReleaseSmall';
  size: number;
  sha256: string;
  minisig: string;
  minisigSource: string;
  publicKey: string;
  signature: {
    keyId: string;
    algorithm: string;
    trustedComment: string;
    signedAt?: string;
  };
  verifiedAt: string;
  license: string;
  wasm: WasmInfo;
}

/** Everything a pin writes to the vendor folder, fetched and verified. */
export interface PinnedRelease {
  bytes: Uint8Array;
  minisig: string;
  license: Uint8Array;
  sidecar: Sidecar;
}

/**
 * Re-checks a vendored pin offline: size, sha256, signature against `publicKey`, and the
 * signed file name.
 *
 * @throws On any mismatch.
 */
export function verifyPinned(
  dir: string,
  publicKey: string,
): { sidecar: Sidecar; sig: MinisigResult } {
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(dir, `${WASM_FILE}.json`), 'utf8'),
  ) as Sidecar;
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, sidecar.file)));
  if (bytes.byteLength !== sidecar.size) {
    throw new Error(`${sidecar.file}: size ${bytes.byteLength} != sidecar ${sidecar.size}`);
  }
  const hash = sha256(bytes);
  if (hash !== sidecar.sha256)
    throw new Error(`${sidecar.file}: sha256 ${hash} != sidecar ${sidecar.sha256}`);
  const sig = verifyMinisign(
    bytes,
    fs.readFileSync(path.join(dir, sidecar.minisig), 'utf8'),
    publicKey,
  );
  if (sig.file !== sidecar.file)
    throw new Error(`signature is for ${sig.file}, not ${sidecar.file}`);
  return { sidecar, sig };
}

/** Writes the wasm, its signature, Ghostty's licence and the sidecar into `dir`. */
export function writePin(dir: string, pin: PinnedRelease): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, WASM_FILE), pin.bytes);
  fs.writeFileSync(path.join(dir, `${WASM_FILE}.minisig`), pin.minisig);
  fs.writeFileSync(path.join(dir, 'LICENSE'), pin.license);
  fs.writeFileSync(
    path.join(dir, `${WASM_FILE}.json`),
    `${JSON.stringify(pin.sidecar, null, 2)}\n`,
  );
}
