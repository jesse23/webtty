# SPEC: Client

**Last Updated:** 2026-10-13

---

## Description

The webtty browser client runs entirely in the browser. It is served as static assets — no server-side HTML rendering, no inline scripts. This makes it CSP-safe (`script-src 'self'` is sufficient) and gives the client code a proper TypeScript foundation for future enhancement.

The client has one surface: a full-viewport terminal view, one session per tab.

**Why static assets?** Inline scripts require `'unsafe-inline'` or a per-request nonce to pass strict CSP. Serving the client as a static JS file loaded via `<script src>` allows `script-src 'self'` with no exceptions. It also enables real TypeScript in the browser — LSP, type checking, imports — rather than an untyped string template. See [ADR 012](../adrs/012.client.static-assets.md).

**Why no framework (React/Vue)?** The client is a single terminal view. A framework adds more complexity than it removes. Revisit when the client grows to multiple pages or components.

## Asset layout

```
dist/
  client.html          ← static HTML shell; served at GET /s/:id
  client-browser.js    ← compiled from src/client/index.ts, with the vendored ghostty-web TS bundled in
  client.css           ← copied from src/client/index.css
  ghostty-vt.wasm      ← copied from src/client/vendor/ghostty-web/; served at GET /ghostty-vt.wasm
  ghostty-vt-small.wasm ← official libghostty-vt (ReleaseSmall), copied from src/client/vendor/ghostty-vt/
                          only if it matches its sidecar's size and sha256; served at GET /ghostty-vt-small.wasm
  THIRD_PARTY_LICENSES ← Coder's ghostty-web and Ghostty's MIT notices, from src/client/vendor/ghostty-web/
                          and src/client/vendor/ghostty-vt/
```

`client.html` loads only `client-browser.js`. The npm `ghostty-web.js` build inlined the wasm as a base64 `data:` URL, so the browser never fetched `/ghostty-vt.wasm`. The vendored TS is bundled without inlining, so the client now fetches it on every page load through an explicit `Ghostty.load('/ghostty-vt.wasm')`, and the page depends on the server serving that route as `application/wasm`. The server resolves the wasm from `dist/` (npm install) or the vendored path (local dev); nothing comes from `node_modules` ([ADR 041](../adrs/041.client.libghostty-vt.md)).

The server resolves `ghostty-vt-small.wasm`, the official libghostty-vt wasm ([ADR 042](../adrs/042.client.official-vt-engine.md)), the same way and serves it at `GET /ghostty-vt-small.wasm` as `application/wasm`.

The client fetches only the selected engine's wasm ([ADR 042](../adrs/042.client.official-vt-engine.md)): `/ghostty-vt.wasm` for the Coder engine, `/ghostty-vt-small.wasm` for the official one. The engine is the build-time default (`DEFAULT_ENGINE` in `engine.ts`, `coder` until the acceptance matrix is recorded) or `?engine=coder|official` in the page URL; any other value uses the default, and nothing is stored. The Coder wasm goes away when the Coder engine is removed.

## Source layout

```
src/client/
  index.ts             ← browser TypeScript entry point
  engine.ts            ← DEFAULT_ENGINE and the ?engine=coder|official override (ADR 042)
  index.html           ← HTML shell (no inline script)
  index.css            ← terminal styles
  vendor/
    ghostty-web/       ← coder/ghostty-web lib/ at 1858a59 (non-test TS, unchanged), MIT LICENSE, PROVENANCE.md;
                          Ghostty's LICENSE.ghostty; Coder ghostty-vt.wasm + ghostty-vt.wasm.json sidecar (npm version, Ghostty commit + patch,
                          licence, size, sha256), checked by vendor/ghostty-web.test.ts;
                          ghostty.ts holds every wasm call for both engines (Coder and official, ADR 042);
                          fn-table.ts is the function-table trampoline borrowed from ghostty-vt-js (LICENSE.ghostty-vt-js)
    fixtures/          ← PTY captures replayed into both engines by vendor/engine-parity.test.ts
    ghostty-vt/        ← official ghostty-vt-small.wasm (Ghostty 05dcf887, ReleaseSmall) + .minisig + sidecar
                          (commit, URL, size, sha256, signature, key, licence), Ghostty LICENSE, PROVENANCE.md;
                          checked offline by vendor/ghostty-vt.test.ts (size, sha256, minisign signature)
scripts/update-ghostty-vt.ts ← fetches and verifies a new pin (the only networked step); --verify re-checks offline
```

The vendored TS is excluded from Biome so it stays byte-identical to upstream until webtty edits it, and is type-checked with the rest of `src/`. webtty's edits to it are tracked in git from the commit that added it. `vendor/ghostty-vt/` is excluded from Biome too, since the update script writes its sidecar; nothing in it is edited.

The Coder wasm and sidecar stay until the Coder engine is removed ([ADR 041](../adrs/041.client.libghostty-vt.md) step 5).

## Page

`GET /s/:id` returns `dist/client.html` — a static HTML shell. On load, `client-browser.js`:

1. Reads `sessionId` from `window.location.pathname` (`/s/main` → `main`)
2. Fetches `GET /api/config` to get terminal config
3. Sets `document.title = sessionId + ' | webtty'`
4. Picks the engine (`?engine=coder|official`, else the build-time default), loads its wasm and initialises the vendored ghostty-web `Terminal` with config values (cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollback, mouseScrollSpeed, theme, copyOnSelect, rightClickBehavior)
5. Connects to `ws://<host>/ws/:id?cols=<cols>&rows=<rows>` over WebSocket
6. Fits the terminal to the viewport from the full container size (no scrollbar reserve, see ADR 033) and observes resize events
7. Sends a `{ type: 'resize', cols, rows }` JSON message on open and on every terminal resize
8. Forwards all keystrokes to the PTY via `term.onData`

## Config endpoint

`GET /api/config` returns client-relevant config keys as JSON:

```ts
{
  cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollback,
  scrollbackLines,        // Official engine: history in lines, 0 = no line limit, 32 MiB ceiling (ADR 046)
  theme, copyOnSelect, rightClickBehavior,
  mouseScrollSpeed,       // Terminal option: SGR wheel ticks per line/page event when the app tracks the mouse
  padding,                // px around the canvas, used by fit(); coloured by theme.padding or theme.background
  keyboardBindings        // used by the keydown capture handler, not passed to Terminal constructor
}
```

Server-only keys (`port`, `host`, `shell`, `term`, `colorTerm`, `logs`) are not exposed.

## Welcome Banner

On the first WebSocket connection to a session (no existing PTY), the server writes a banner to the terminal:

```
╔══════════════════════════════════════════════════════╗
║                                                      ║
║ [ webtty ]   Terminal UI in the browser              ║
║                                                      ║
║ Run `bunx webtty help` for more information.         ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
```

- `[ webtty ]` — dim brackets, bold yellow name
- Slogan — dim
- Help command — dim italic surroundings, foreground italic for the command itself
- Package runner (`bunx` or `npx`) detected from the server's runtime at startup

## Status Messages

All status messages written to the terminal share a consistent style:

```
[ webtty ] <message>
```

| Event | Message | Behavior |
|-------|---------|----------|
| WS close `4001` (session deleted or shell exited) | `Session removed.` | `window.close()` after 500ms |
| WS close `1001` (server stopped) | `Server stopped.` | `window.close()` after 500ms |
| WS close (unexpected) | `Connection lost. Reconnecting in 2s...` | Reconnect after 2s |
| WS error | `WebSocket error.` | — |

## Keyboard Bindings

Browser `KeyboardEvent` objects do not carry terminal escape sequences — the browser has no knowledge of the Alacritty/Ghostty custom-binding convention that maps modifier+key combos to specific byte sequences. As a result, keys like Shift+Enter arrive at ghostty-web as a plain `keydown` with `shiftKey=true`, and ghostty-web sends the same `\r` it would for unmodified Enter — not the `\x1b\r` (ESC CR) that TUI apps such as opencode expect.

A capture-phase `keydown` listener on the terminal container fires before ghostty-web's canvas handlers and intercepts matching bindings:

1. Walk `config.keyboardBindings` (user-configured entries).
2. Normalize `event.key` to lowercase and compare against each binding's `key`+`mods`.
3. On match: call `e.preventDefault()` + `e.stopPropagation()` to suppress ghostty-web's default handling, then send `binding.chars` verbatim over WebSocket to the PTY.
4. No match: return immediately — ghostty-web handles as normal.

**`chars` encoding:** The client sends `binding.chars` verbatim. Standard JSON escapes (`\uXXXX`, `\r`, `\n`, `\t`) are resolved by `JSON.parse` at config load — no further processing occurs.

See [key-bindings spec](key-bindings.md) for the binding object schema and examples.

## Font-size Zoom

`Ctrl/Cmd` + `=`, `-`, or `0` adjust the terminal font size in-session, matching VS Code and native terminal conventions. These shortcuts are **not configurable** — they are a fixed client-side UI gesture, not PTY input, and cannot be overridden via `keyboardBindings`.

| Key | Action |
|-----|--------|
| `Ctrl/Cmd` + `=` or `+` | Increase font size by 1 (max 32) |
| `Ctrl/Cmd` + `-` | Decrease font size by 1 (min 6) |
| `Ctrl/Cmd` + `0` | Reset to `config.fontSize` (clamped to 6–32) |

Numpad `+`, `-`, and `0` are also recognised.

A capture-phase `keydown` listener on `window` fires first. It calls `preventDefault()` to suppress browser page-zoom and `stopPropagation()` to prevent the key from reaching ghostty-web's PTY input path. Font size is not persisted — reload returns to `config.fontSize`.

See [ADR 023](../adrs/023.client.font-size-zoom.md).

## Copy Behavior

Controlled by two config keys from `GET /api/config`:

| Config | Default | Behavior |
|--------|---------|----------|
| `copyOnSelect: true` | on | Auto-copies selection to clipboard on mouseup via `term.onSelectionChange`. Context menu untouched. |
| `rightClickBehavior: "copyPaste"` | off | Right-click with selection copies + clears selection. `e.preventDefault()` only fires when selection exists. |

Both can be active simultaneously. The canvas-based terminal has no DOM text selection — these are the only reliable copy paths.

## Behavior Notes

### Tab close on session end

When a session ends (shell exits → WS close code `4001`) or the server stops (`webtty stop` → WS close code `1001`), the client calls `window.close()` after 500ms.

**Browser restriction**: `window.close()` is only permitted on tabs opened programmatically via `window.open()` or duplicated from such tabs.

- Tabs opened by `webtty at` → close automatically ✅
- Tabs opened by manually navigating to the server URL → display the status message but remain open ⚠️

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Static asset build | Browser TS compiled by `Bun.build()`; HTML/CSS copied to `dist/`; zero inline script | [ADR 012](../adrs/012.client.static-assets.md) | ✅ |
| Terminal view | Full-viewport terminal using `ghostty-web`, auto-fit, WebSocket reconnect on disconnect | [ADR 001](../adrs/001.webtty.bootstrap.md) | ✅ |
| Config endpoint | `GET /api/config` — serves client-relevant config keys; replaces server-side template injection | [ADR 012](../adrs/012.client.static-assets.md) | ✅ |
| Session support | `GET /s/:id` opens a named session; `GET /` redirects to last-used or creates `main` | [ADR 005](../adrs/005.client.session-support.md) | ✅ |
| Multi-client | Multiple tabs can attach to the same session; scrollback replayed on reconnect; tab closes when PTY exits | [ADR 007](../adrs/007.webtty.session-client.md) | ✅ |
| Welcome banner and status messages | `[ webtty ]`-styled banner on first connect; consistent status messages for disconnect, error, and server stop | [ADR 010](../adrs/010.client.ux-polish.md) | ✅ |
| Copy behavior | `copyOnSelect` + `rightClickBehavior` — two independent configurable copy modes | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Cursor style | `cursorStyle` / `cursorStyleBlink` defaults; DECSCUSR from PTY overrides at runtime inside the terminal (Ps 0 restores the default), and the cursor cell is repainted so the old shape does not linger | [ADR 013](../adrs/013.client.cursor-style.md), [ADR 015](../adrs/015.client.cursor-ghost-repaint.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Non-text paste | Ctrl+V with no `text/plain` in clipboard forwards `\x16` to PTY; TUI apps read non-text content via their native OS clipboard API | [ADR 014](../adrs/014.client.image-paste.md) | ✅ |
| Multiline text paste | Bracket text only when mode 2004 is enabled; otherwise send raw text (newlines may act as Enter in apps without bracketed paste), never Ctrl+V | [ADR 037](../adrs/037.client.multiline-text-paste.md) | ✅ |
| IME / dictation at cursor | The terminal keeps focus on its input textarea, which follows the cursor cell; the composition shows at the cursor in the theme's font and colours instead of as a stray line under the canvas | [ADR 038](../adrs/038.client.ime-composition-at-cursor.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Device pixel ratio changes | Moving to a monitor with a different scale, or changing zoom, is followed by the renderer, which repaints instead of staying blurry until reload; fractional ratios render at the next whole ratio so the canvas doesn't resize every frame | [ADR 039](../adrs/039.client.device-pixel-ratio-change.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Pixel-smooth scrollback | Trackpad scrolling through scrollback moves by pixels (the renderer's overscan canvas moved by the offset, ADR 043; the one-row strip is gone); in mouse-tracking apps, pixel deltas send one scroll tick per cell height of travel | [ADR 040](../adrs/040.client.pixel-smooth-scroll.md), [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Vendored terminal layer | The terminal (renderer, input, selection) is webtty's own vendored code with no npm `ghostty-web` dependency; terminal behaviour is unchanged | [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| ghostty-web bugs fixed at source | ghostty-web bugs are fixed in the vendored code instead of patched from outside, each fix deleting its webtty workaround (hover motion, cursor interceptor, fit reserve, private `devicePixelRatio` set, and the rest of ADR 041 step 2) | [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Official libghostty-vt engine, opt-in | `?engine=official` runs the terminal on Ghostty's official, unpatched libghostty-vt wasm (pinned, sha256- and signature-checked offline), with current Ghostty parsing and query replies; the Coder engine stays the default (superseded by the row below) | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 042](../adrs/042.client.official-vt-engine.md) | ✅ |
| Official engine only | Every tab runs Ghostty's official libghostty-vt wasm; the Coder engine, its wasm, `/ghostty-vt.wasm` and `?engine` are removed without a release on an official default, after ADR 042's acceptance record and a manual check in Chrome, Firefox and Safari. The `kitty.ts` size replies, the stream-scanned bell and title, `colorsSet` and the `scrollback`-derived history go with it; history is always `scrollbackLines`. Cursor style, mouse and paste encoders and theme colours from render state remain follow-ups | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 042](../adrs/042.client.official-vt-engine.md), [ADR 047](../adrs/047.client.official-engine-only.md) | ⬜ |
| Scrollback in lines | Terminal history keeps the configured number of lines (`scrollbackLines`, default 10,000, a little under from page pruning) up to a 32 MiB ceiling, instead of a few hundred rows | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 046](../adrs/046.client.scrollback-lines.md) | ✅ |
| Scroll copies rows | A whole-line scroll copies the rows still in view with one canvas self-copy and draws only the rows that came into view; a frame with nothing changed, including one parked in scrollback, draws nothing; every partial frame equals a full redraw | [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Smooth scroll via overscan | Pixel-smooth scrollback draws 16 extra rows above and below the viewport (from the scrollback provider on both engines), when they come into view, and translates the canvas across them before copying rows, replacing ADR 040's strip canvas | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Smooth mouse wheel | A mouse wheel notch glides to its target over 125 ms (ease-out cubic), and notches during a glide add up; a sparse stream of pixel deltas (a TrackPoint) glides each delta linearly over the time it took to arrive, or follows a spring while the stream is fast, and in apps the scroll ticks of wheel notches and sparse deltas are paced over the same times instead of sent in a burst; a trackpad still scrolls immediately. VS Code's classifier tells the two apart by their recent deltas | [ADR 045](../adrs/045.client.smooth-mouse-wheel.md) | ✅ |
| ~~Glyph cache~~ | ~~Full repaints copy glyphs from an atlas canvas instead of calling `fillText` per cell~~: in Chrome it took about twice the script and GPU time of `fillText`, and `measureText` ink boxes were not exact enough | [ADR 044](../adrs/044.client.glyph-cache.md) | ❌ rejected |
| Mouse scroll | When the PTY app enables mouse tracking (e.g. vim `set mouse=a`), the terminal forwards wheel events as SGR mouse sequences (`\x1b[<64/65;col;rowM`) instead of arrow keys, so apps scroll their buffer rather than move the cursor | [ADR 017](../adrs/017.client.mouse-scroll.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Keyboard bindings | Capture-phase `keydown` handler intercepts configured `key`+`mods` combos and sends `chars` to PTY; defaults to `[]` (no built-in bindings) | [ADR 018](../adrs/018.key-bindings.config-support.md) | ✅ |
| Canvas gap fill | After each fit, distribute the gap between the container and canvas as symmetric padding so the canvas is centred at the new size | [ADR 022](../adrs/022.client.canvas-fill.md) | ✅ |
| Font-size zoom | `Ctrl/Cmd` + `=`/`-`/`0` adjust terminal font size in-session; not configurable; same shortcuts as VS Code | [ADR 023](../adrs/023.client.font-size-zoom.md) | ✅ |
| Kitty graphics | Client intercepts kitty graphics APC sequences and draws images on an overlay canvas; enables terminal-browser and `icat`-style tools | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Tighter fit | Grid sized by the vendored `FitAddon` from the full container, with no scrollbar reserve, shrinking the strip at the edges to under one cell; what is left over is handled by the padding and edge-extension rows below | [ADR 033](../adrs/033.client.padding-fit.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Configurable padding | Top-level `padding` (px, default `0`) reserves space around the canvas on all sides; the grid is fitted to what remains; the top and left gap is exactly `padding` and the leftover goes to the right and bottom; optional `theme.padding` colours the space `padding` adds (default: `theme.background`) but not the leftover | [ADR 034](../adrs/034.client.padding-config.md) | ✅ |
| Edge extension | The leftover strip at the right and bottom takes the edge cells' own background, by repainting the canvas' last pixel row and column across it; always on, no setting | [ADR 035](../adrs/035.client.edge-extend.md) | ✅ |
| Theme key mapping | The config's `purple`, `brightPurple` and `selection` are translated to the terminal's `magenta`, `brightMagenta` and `selectionBackground`, which were previously ignored; `selectionForeground` is new and defaults to `background` when `selection` is set | [ADR 036](../adrs/036.client.theme-key-mapping.md) | ✅ |
