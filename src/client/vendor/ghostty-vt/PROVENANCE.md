# Provenance

Ghostty's official libghostty-vt wasm, ReleaseSmall build, unpatched and not edited. MIT licence, Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors (see [LICENSE](LICENSE), copied from Ghostty at the pinned commit). See [ADR 041](../../../../docs/adrs/041.client.libghostty-vt.md) and [ADR 042](../../../../docs/adrs/042.client.official-vt-engine.md).

- **`ghostty-vt-small.wasm`:** built by Ghostty's tip CI (`.github/workflows/release-tip.yml`) from [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty) at `05dcf887ef51ea27821f20979493306ec3a19149` (2026-10-13), downloaded from `https://tip.files.ghostty.org/<commit>/ghostty-vt-small.wasm`. The wasm does not record its commit (`ghostty_build_info` reports `0.1.0-dev`); the sidecar is the only record.
- **`ghostty-vt-small.wasm.minisig`:** from the GitHub `tip` release while `tip` pointed at that commit, with the GitHub asset byte-identical to the commit-addressed one. It is Ghostty's minisign signature with the release key from Ghostty's `PACKAGING.md` (`RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV`, key id `F5787DDB42320225`).
- **`ghostty-vt-small.wasm.json`:** the sidecar: commit, source URL, size, sha256, signature source, public key, the signature's key id and trusted comment, licence, and the wasm's exports and `ghostty_build_info`.

Checked offline by `src/client/vendor/tests/ghostty-vt.test.ts` (size, sha256, signature, key) on every `bun test`, and by `bun scripts/update-ghostty-vt.ts --verify`. `scripts/build.ts` refuses to copy a wasm whose size or sha256 does not match the sidecar, and writes the licence to `dist/THIRD_PARTY_LICENSES`.

The wasm, signature, sidecar and `LICENSE` are written by `bun scripts/update-ghostty-vt.ts --commit <sha>`, the only step that uses the network, and are not edited by hand. A pin bump is a deliberate change: update the commit above and re-run the binding's tests (`vendor/tests/engine/`, `official-replay.test.ts`, ADR 041).
