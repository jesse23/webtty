# Provenance

Vendored copy of [coder/ghostty-web](https://github.com/coder/ghostty-web), MIT licence, Copyright (c) 2025 Coder (see [LICENSE](LICENSE)). See [ADR 041](../../../../docs/adrs/041.client.libghostty-vt.md).

- **Upstream commit:** `1858a5947767a3e1c9e98dbf53b2ff87fedb2aab` (2026-06-28), the `gitHead` of npm `ghostty-web@0.4.0-next.20.g1858a59`.
- **TypeScript:** every non-test file under upstream `lib/` (including `addons/` and `providers/`), copied byte for byte. Upstream's tests (`*.test.ts`, `test-helpers.ts`) and its happy-dom preload were not copied.
- **`ghostty-vt.wasm`:** copied byte for byte from the npm package. Built by Coder from Ghostty `5714ed07a1012573261b7b7e3ed2add9c1504496` plus upstream `patches/ghostty-wasm-api.patch`, so it is Ghostty code under Ghostty's MIT licence, Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors ([LICENSE.ghostty](LICENSE.ghostty), copied from Ghostty at that commit), plus Coder's MIT-licensed patch. Size and sha256 are in [ghostty-vt.wasm.json](ghostty-vt.wasm.json) and checked by `src/client/vendor/ghostty-web.test.ts`.

`bun run build` writes both notices to `dist/THIRD_PARTY_LICENSES`.

webtty edits to these files are tracked in git from the commit that added them; diff against that commit to see them.

## Local changes

- `terminal.ts`: the mouse cursor is the default arrow instead of the `text` I-beam when not over a link (`mouseCursorFor`); `pointer` over links is unchanged.
- `input-handler.ts`: mouse motion with no button held is reported as button 35 instead of 32, the left-drag code (`mouseMotionButton`), a release outside the terminal no longer leaves a button held, and motion is reported once per cell instead of per `mousemove` (`isNewMouseCell`).
- `renderer.ts`: the canvas is drawn at the device pixel ratio rounded up to a whole number (`wholeDevicePixelRatio`), backing-store sizes are rounded the same way in `resize()` and `render()`, ratio changes are followed through a re-armed resolution media query (`watchDevicePixelRatio`), and `devicePixelRatio` is a public read-only getter.
- `renderer.ts`: `render()` reads the viewport once per frame through `getViewport` and serves screen rows, including the cursor cell, as slices of that snapshot (`frameLines`) instead of calling `getLine` per row, which copied and parsed the whole viewport each time.
- `terminal.ts`: `write()` applies DECSCUSR (`scanDecscusr`, `decscusrShape`) as an app cursor shape over the configured `cursorStyle` / `cursorBlink`, which Ps 0 and `reset()` restore; `renderer.ts`: a style or blink change repaints the cursor row on the next frame so the old shape does not stay under the new one.
