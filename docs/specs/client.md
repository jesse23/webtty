# SPEC: Client

**Author:** jesse23
**Last Updated:** 2026-03-26

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
  client-browser.js    ← compiled from src/client/index.ts
  client.css           ← copied from src/client/index.css
  ghostty-web.js       ← ghostty-web package
  ghostty-vt.wasm      ← ghostty-web package
```

## Source layout

```
src/client/
  index.ts             ← browser TypeScript entry point
  index.html           ← HTML shell (no inline script)
  index.css            ← terminal styles
```

## Page

`GET /s/:id` returns `dist/client.html` — a static HTML shell. On load, `client-browser.js`:

1. Reads `sessionId` from `window.location.pathname` (`/s/main` → `main`)
2. Fetches `GET /api/config` to get terminal config
3. Sets `document.title = sessionId + ' | webtty'`
4. Initialises a `ghostty-web` `Terminal` with config values (cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollback, theme, copyOnSelect, rightClickBehavior)
5. Connects to `ws://<host>/ws/:id?cols=<cols>&rows=<rows>` over WebSocket
6. Fits the terminal to the viewport and observes resize events via `FitAddon`
7. Sends a `{ type: 'resize', cols, rows }` JSON message on open and on every terminal resize
8. Forwards all keystrokes to the PTY via `term.onData`

## Config endpoint

`GET /api/config` returns client-relevant config keys as JSON:

```ts
{
  cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollback,
  theme, copyOnSelect, rightClickBehavior
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
| Cursor style | `cursorStyle` / `cursorStyleBlink` defaults; DECSCUSR from PTY overrides at runtime via client-side intercept | [ADR 013](../adrs/013.client.cursor-style.md) | ✅ |
| Non-text paste | Ctrl+V with no `text/plain` in clipboard forwards `\x16` to PTY; TUI apps read non-text content via their native OS clipboard API | [ADR 014](../adrs/014.client.image-paste.md) | ✅ |
