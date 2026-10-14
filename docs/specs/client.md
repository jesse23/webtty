# SPEC: Client

**Last Updated:** 2026-10-14

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
  ghostty-vt-small.wasm ← official libghostty-vt (ReleaseSmall), copied from src/client/vendor/ghostty-vt/
                          only if it matches its sidecar's size and sha256; served at GET /ghostty-vt-small.wasm
  THIRD_PARTY_LICENSES ← MIT notices for Coder's ghostty-web TS, Ghostty's libghostty-vt and ghostty-vt-js,
                          from src/client/vendor/ghostty-web/ and src/client/vendor/ghostty-vt/
```

`client.html` loads only `client-browser.js`. The npm `ghostty-web.js` build inlined the wasm as a base64 `data:` URL. The vendored TS is bundled without inlining, so the client fetches the wasm on every page load through an explicit `Ghostty.load('/ghostty-vt-small.wasm')`, and the page depends on the server serving that route as `application/wasm`. It is Ghostty's official libghostty-vt wasm, the only engine ([ADR 042](../adrs/042.client.official-vt-engine.md), [ADR 047](../adrs/047.client.official-engine-only.md)). The server resolves it from `dist/` (npm install) or the vendored path (local dev); nothing comes from `node_modules` ([ADR 041](../adrs/041.client.libghostty-vt.md)). `GET /ghostty-vt.wasm`, the Coder engine's wasm until ADR 047, returns 404, and `?engine=` in a page URL is ignored.

## Source layout

```
src/client/
  index.ts             ← browser TypeScript entry point
  index.html           ← HTML shell (no inline script)
  index.css            ← terminal styles
  vendor/
    ghostty-web/       ← coder/ghostty-web lib/ at 1858a59 (non-test TS, unchanged), MIT LICENSE, PROVENANCE.md;
                          ghostty.ts holds every wasm call, the binding to the official wasm (ADR 042, ADR 047);
                          fn-table.ts is the function-table trampoline borrowed from ghostty-vt-js (LICENSE.ghostty-vt-js)
    fixtures/          ← PTY captures replayed in 1-byte and 512-byte writes by vendor/official-replay.test.ts
    ghostty-vt/        ← official ghostty-vt-small.wasm (Ghostty 05dcf887, ReleaseSmall) + .minisig + sidecar
                          (commit, URL, size, sha256, signature, key, licence), Ghostty LICENSE, PROVENANCE.md;
                          checked offline by vendor/ghostty-vt.test.ts (size, sha256, minisign signature)
scripts/update-ghostty-vt.ts ← fetches and verifies a new pin (the only networked step); --verify re-checks offline
```

The vendored TS is excluded from Biome so it stays byte-identical to upstream until webtty edits it, and is type-checked with the rest of `src/`. webtty's edits to it are tracked in git from the commit that added it. `vendor/ghostty-vt/` is excluded from Biome too, since the update script writes its sidecar; nothing in it is edited.

## Page

`GET /s/:id` returns `dist/client.html` — a static HTML shell. On load, `client-browser.js`:

1. Reads `sessionId` from `window.location.pathname` (`/s/main` → `main`)
2. Fetches `GET /api/config` to get terminal config
3. Sets `document.title = sessionId + ' | webtty'`
4. Loads the official libghostty-vt wasm and initialises the vendored ghostty-web `Terminal` with config values (cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollbackLines, mouseScrollSpeed, theme, copyOnSelect, rightClickBehavior)
5. Connects to `ws://<host>/ws/:id/pty?cols=<cols>&rows=<rows>&flow=1` over WebSocket, and acknowledges output as it parses it: `{ type: 'ack', chars }`, the characters parsed since connecting, every 64 Ki characters and 100 ms after output stops (ADR 048)
6. Fits the terminal to the viewport from the full container size (no scrollbar reserve, see ADR 033) and observes resize events
7. Sends a `{ type: 'resize', cols, rows }` JSON message on open and on every terminal resize
8. Forwards all keystrokes to the PTY via `term.onData`

## Config endpoint

`GET /api/config` returns client-relevant config keys as JSON:

```ts
{
  cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink,
  scrollback,             // the server's replay buffer; the client does not read it (ADR 047)
  scrollbackLines,        // history in lines, 0 = no line limit, 32 MiB ceiling (ADR 046)
  theme, copyOnSelect, rightClickBehavior,
  clipboardWrite,         // Terminal option: report OSC 52 clipboard writes (ADR 052)
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
| WS close `4003` (tab fell behind the output) | `Tab fell behind; replaying recent output.` | Terminal reset, reconnect at once |
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
| `copyOnSelect` | `true` | Copies a mouse selection (drag, double or triple click) to the clipboard once, on mouseup, through the Terminal's `copyOnSelect` option; off, nothing is copied. |
| `rightClickBehavior` | `"contextMenu"` | What a right-click the app does not take does: `"contextMenu"` the browser menu (over the textarea, so it offers Copy and Paste); `"copyPaste"` copy and clear a selection, else the menu; `"paste"` paste the clipboard (the Ctrl+V path, ADR 037); `"none"` nothing, no menu. `"default"` is read as `"contextMenu"`. |

Both can be active simultaneously. The canvas-based terminal has no DOM text selection — these are the only reliable copy paths.

**The app's mouse comes first** ([ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md)). While the app tracks the mouse (any DEC mouse tracking mode), a press is the app's unless Shift is held, as in Ghostty, kitty, WezTerm, xterm, Windows Terminal and VS Code. `mouse-route.ts` holds the rule (`pressToApp`, `rightClickAction`), and the input handler, the selection manager and the terminal all ask it:

| | Left drag, double/triple click | Right-click |
|---|---|---|
| App does not track the mouse | webtty selects; copied on release with `copyOnSelect` | `rightClickBehavior` |
| App tracks the mouse | only the app gets press, motion and release; no highlight, no copy | only the app gets it; browser menu cancelled |
| App tracks the mouse, Shift held | webtty selects and copies; the app gets nothing for that button until it is released | `rightClickBehavior`; the app gets nothing |

The terminal has the one `contextmenu` listener (`handleContextMenu`). A menu not preceded by a right press (or macOS Ctrl+click) since the last key is a keyboard menu and follows `rightClickBehavior` even while the app tracks the mouse. While the terminal has focus, the Menu key and Shift+F10 are sent to the app as keys, so the browser opens no keyboard menu there. `"paste"` fires `Terminal.onPasteRequest`, which `index.ts` answers with the same clipboard read as Ctrl+V.

What a double or triple click selects, and the text either path copies, is Ghostty's (`ghostty_terminal_select_word`, `ghostty_terminal_select_line`, `ghostty_terminal_selection_format_alloc`): soft-wrapped rows are joined without a newline ([ADR 050](../adrs/050.client.selection-from-libghostty-vt.md)).

## Program Clipboard Writes

Programs write the clipboard with OSC 52 (`ESC ] 52 ; c ; <base64> BEL` or ST), as Claude Code, pi, Neovim 0.10+ and tmux `set-clipboard` do over SSH ([ADR 052](../adrs/052.client.osc52-clipboard-write.md)). Ghostty parses and decodes it (also iTerm2's `OSC 1337 ; Copy` and kitty's OSC 5522) and calls the binding's `CLIPBOARD_WRITE` callback, installed only while `clipboardWrite` is on:

| Sequence | Result |
|---|---|
| `52;c;<base64>`, `52;;<base64>`, any selection other than `s`/`p` | the clipboard gets the text, decoded as UTF-8 (invalid bytes become U+FFFD) |
| `52;s;…`, `52;p;…`, `52;pc;…` | nothing, as in Ghostty on macOS |
| `52;c;` (empty) | the clipboard is cleared (set to `''`) |
| `52;c;?` (query) | no answer, ever |
| invalid base64, or a sequence over 8 MiB (about 6 MiB of text) | ignored whole; missing padding is accepted |

`readEffects` reports the last write since the previous call, `Terminal.onClipboardWrite` fires with it, and `index.ts` passes it to `ClipboardWriter` (`clipboard-write.ts`), which calls `navigator.clipboard.writeText`. After each (re)connect it ignores writes until a `keydown`, `mousedown`, `paste` or `drop` in the tab, so the replayed history does not overwrite the clipboard on reload. A missing clipboard API (http other than localhost), a refused write (no focus in Chrome, no recent input in Firefox, most writes in Safari) and a write held back for the replay are each logged to the console once; there is no error UI.

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
| Output acknowledgements | Output is acknowledged as it is parsed, so the server sends it in order at the tab's pace; a tab closed with `4003` for falling behind resets and reconnects to the replay | [ADR 048](../adrs/048.webtty.output-flow-control.md) | ✅ |
| Welcome banner and status messages | `[ webtty ]`-styled banner on first connect; consistent status messages for disconnect, error, and server stop | [ADR 010](../adrs/010.client.ux-polish.md) | ✅ |
| Copy behavior | `copyOnSelect` + `rightClickBehavior` — two independent configurable copy modes | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Program clipboard writes (OSC 52) | OSC 52 (and OSC 1337 Copy, OSC 5522) writes from programs reach the browser clipboard: writes only, the standard clipboard only, UTF-8 text, held back after each connect until the user acts in the tab so the replay never writes; `clipboardWrite: false` turns it off | [ADR 052](../adrs/052.client.osc52-clipboard-write.md) | ✅ |
| Mouse follows app tracking | While the app tracks the mouse, drags, double/triple clicks and right-clicks go only to the app: webtty draws no highlight, copies nothing and cancels the browser menu. Shift selects in webtty (and applies `rightClickBehavior`) and sends nothing to the app. `rightClickBehavior` is `"contextMenu"` (default), `"copyPaste"`, `"paste"` or `"none"`, all handled in one function | [ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md) | ✅ |
| Cursor style | `cursorStyle` / `cursorStyleBlink` are Ghostty's default cursor; Ghostty applies DECSCUSR from the PTY (Ps 0 and RIS restore the default); mode 12 is ignored, as in Ghostty with `cursor-style-blink` set; and the renderer draws the shape and blink from its state, repainting the cursor cell so the old shape does not linger | [ADR 013](../adrs/013.client.cursor-style.md), [ADR 015](../adrs/015.client.cursor-ghost-repaint.md), [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| Non-text paste | Ctrl+V with no `text/plain` in clipboard forwards `\x16` to PTY; TUI apps read non-text content via their native OS clipboard API | [ADR 014](../adrs/014.client.image-paste.md) | ✅ |
| Multiline text paste | Text is encoded by Ghostty's `ghostty_terminal_paste`: bracketed whenever mode 2004 is enabled (single lines too), control bytes replaced with spaces, and without 2004 sent with newlines as CR (they may act as Enter in apps without bracketed paste), never Ctrl+V | [ADR 037](../adrs/037.client.multiline-text-paste.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| IME / dictation at cursor | The terminal keeps focus on its input textarea, which follows the cursor cell; the composition shows at the cursor in the theme's font and colours instead of as a stray line under the canvas | [ADR 038](../adrs/038.client.ime-composition-at-cursor.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Device pixel ratio changes | Moving to a monitor with a different scale, or changing zoom, is followed by the renderer, which repaints instead of staying blurry until reload; fractional ratios render at the next whole ratio so the canvas doesn't resize every frame | [ADR 039](../adrs/039.client.device-pixel-ratio-change.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Pixel-smooth scrollback | Trackpad scrolling through scrollback moves by pixels (the renderer's overscan canvas moved by the offset, ADR 043; the one-row strip is gone); in mouse-tracking apps, pixel deltas send one scroll tick per cell height of travel | [ADR 040](../adrs/040.client.pixel-smooth-scroll.md), [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Vendored terminal layer | The terminal (renderer, input, selection) is webtty's own vendored code with no npm `ghostty-web` dependency; terminal behaviour is unchanged | [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| ghostty-web bugs fixed at source | ghostty-web bugs are fixed in the vendored code instead of patched from outside, each fix deleting its webtty workaround (hover motion, cursor interceptor, fit reserve, private `devicePixelRatio` set, and the rest of ADR 041 step 2) | [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Official libghostty-vt engine, opt-in | `?engine=official` runs the terminal on Ghostty's official, unpatched libghostty-vt wasm (pinned, sha256- and signature-checked offline), with current Ghostty parsing and query replies; the Coder engine stays the default (superseded by the row below) | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 042](../adrs/042.client.official-vt-engine.md) | ✅ |
| Official engine only | Every tab runs Ghostty's official libghostty-vt wasm; the Coder engine, its wasm, `/ghostty-vt.wasm` and `?engine` are removed without a release on an official default, after ADR 042's acceptance record and a manual check in Chrome, Firefox and Safari. The `kitty.ts` size replies, the stream-scanned bell and title, `colorsSet` and the `scrollback`-derived history go with it; history is always `scrollbackLines`. Cursor style, mouse and paste encoders moved to the official APIs in ADR 049; theme colours from render state remain a follow-up | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 042](../adrs/042.client.official-vt-engine.md), [ADR 047](../adrs/047.client.official-engine-only.md) | ✅ |
| Scrollback in lines | Terminal history keeps the configured number of lines (`scrollbackLines`, default 10,000, a little under from page pruning) up to a 32 MiB ceiling, instead of a few hundred rows | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 046](../adrs/046.client.scrollback-lines.md) | ✅ |
| Mouse, cursor style and paste from libghostty-vt | Mouse reports (clicks, motion, drags past the edge, wheel ticks) are encoded by Ghostty's mouse encoder in every tracking mode and format, with Alt and buttons 8/9, at a device-pixel geometry that includes the padding; the cursor shape and blink come from Ghostty's state, with the config as its default; pastes go through `ghostty_terminal_paste` (bracketed whenever mode 2004 is on, control bytes stripped). X10-format reports past column 95 are dropped: they cannot travel as text frames | [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) |✅ |
| Selection from libghostty-vt | A double click selects Ghostty's word (URLs with queries, non-ASCII words, across a soft wrap), a triple click the whole logical line without its indent, and copied text is Ghostty's: soft-wrapped rows joined without a newline, trailing whitespace trimmed, wide characters whole. Drag, `copyOnSelect`, scrollback selection and the highlight are unchanged | [ADR 050](../adrs/050.client.selection-from-libghostty-vt.md) | ✅ |
| Scroll copies rows | A whole-line scroll copies the rows still in view with one canvas self-copy and draws only the rows that came into view; a frame with nothing changed, including one parked in scrollback, draws nothing; every partial frame equals a full redraw | [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Smooth scroll via overscan | Pixel-smooth scrollback draws 16 extra rows above and below the viewport (from the scrollback provider), when they come into view, and translates the canvas across them before copying rows, replacing ADR 040's strip canvas | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Smooth mouse wheel | A mouse wheel notch glides to its target over 125 ms (ease-out cubic), and notches during a glide add up; a sparse stream of pixel deltas (a TrackPoint) glides each delta linearly over the time it took to arrive, or follows a spring while the stream is fast, and in apps the scroll ticks of wheel notches and sparse deltas are paced over the same times instead of sent in a burst; a trackpad still scrolls immediately. VS Code's classifier tells the two apart by their recent deltas | [ADR 045](../adrs/045.client.smooth-mouse-wheel.md) | ✅ |
| ~~Glyph cache~~ | ~~Full repaints copy glyphs from an atlas canvas instead of calling `fillText` per cell~~: in Chrome it took about twice the script and GPU time of `fillText`, and `measureText` ink boxes were not exact enough | [ADR 044](../adrs/044.client.glyph-cache.md) | ❌ rejected |
| Mouse scroll | When the PTY app enables mouse tracking (e.g. vim `set mouse=a`), the terminal forwards wheel events as mouse buttons 4/5 at the pointer's cell, encoded by Ghostty in the app's format (`\x1b[<64/65;col;rowM` under SGR), instead of arrow keys, so apps scroll their buffer rather than move the cursor | [ADR 017](../adrs/017.client.mouse-scroll.md), [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| Keyboard bindings | Capture-phase `keydown` handler intercepts configured `key`+`mods` combos and sends `chars` to PTY; defaults to `[]` (no built-in bindings) | [ADR 018](../adrs/018.key-bindings.config-support.md) | ✅ |
| Canvas gap fill | After each fit, distribute the gap between the container and canvas as symmetric padding so the canvas is centred at the new size | [ADR 022](../adrs/022.client.canvas-fill.md) | ✅ |
| Font-size zoom | `Ctrl/Cmd` + `=`/`-`/`0` adjust terminal font size in-session; not configurable; same shortcuts as VS Code | [ADR 023](../adrs/023.client.font-size-zoom.md) | ✅ |
| Kitty graphics | Client intercepts kitty graphics APC sequences and draws images on an overlay canvas; enables terminal-browser and `icat`-style tools | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Tighter fit | Grid sized by the vendored `FitAddon` from the full container, with no scrollbar reserve, shrinking the strip at the edges to under one cell; what is left over is handled by the padding and edge-extension rows below | [ADR 033](../adrs/033.client.padding-fit.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Configurable padding | Top-level `padding` (px, default `0`) reserves space around the canvas on all sides; the grid is fitted to what remains; the top and left gap is exactly `padding` and the leftover goes to the right and bottom; optional `theme.padding` colours the space `padding` adds (default: `theme.background`) but not the leftover | [ADR 034](../adrs/034.client.padding-config.md) | ✅ |
| Edge extension | The leftover strip at the right and bottom takes the edge cells' own background, by repainting the canvas' last pixel row and column across it; always on, no setting | [ADR 035](../adrs/035.client.edge-extend.md) | ✅ |
| Theme key mapping | The config's `purple`, `brightPurple` and `selection` are translated to the terminal's `magenta`, `brightMagenta` and `selectionBackground`, which were previously ignored; `selectionForeground` is new and defaults to `background` when `selection` is set | [ADR 036](../adrs/036.client.theme-key-mapping.md) | ✅ |
