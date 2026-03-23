# SPEC: webtty

**Author:** jesse23
**Last Updated:** 2026-03-22

---

## Description

webtty is a web TTY that lets you run CLI/TUI applications in a browser tab, on any platform. Point a browser at a running webtty server and you get a full terminal — colors, cursor, resize, keyboard input — backed by a real PTY on the host machine.

The goal is the same as ttyd and GoTTY: zero client-side installation, full TUI support, cross-platform. webtty uses `ghostty-web` as the terminal renderer (WASM-backed, same API as xterm.js) and `@lydell/node-pty` for cross-platform PTY support.

**Why a single-port design?** Simplifies reverse proxy setup (nginx, ngrok, Cloudflare Tunnel) — one upstream, no separate port for assets vs API vs WebSocket. Same pattern used by ttyd and ghostty-web/demo.

**Why `ws` over Socket.IO?** Minimal footprint, no client-side library requirement, sufficient for raw PTY streaming. Socket.IO's rooms/namespaces are unnecessary overhead for this use case.

**Persona:** Developers who want shell or TUI app access from any browser tab.

## Sessions

Sessions are PTY instances keyed by ID. Each session has a unique ID and a running PTY process. Sessions survive WebSocket disconnects but not server restarts (memory-only — webtty defers long-lived persistence to `tmux`/`screen`).

New sessions use the shell from `~/.webtty/config.json`. No per-session command override.

### Session data model

```typescript
interface Session {
  id: string;         // URL-safe identifier (user-supplied or auto-generated)
  createdAt: number;  // Unix timestamp ms
  connected: boolean; // Whether a WebSocket client is currently attached
}
```

### Session ID rules

Session IDs appear directly in the URL path (`/s/:id`), so they must be valid URL path segments:

- Allowed characters: `a-z`, `0-9`, `-`, `_`, `.`
- No uppercase, no spaces, no slashes, no percent-encoding required
- Length: 1–64 characters
- Auto-generated IDs: 8-character lowercase hex (e.g. `a3f2c1d0`)

## REST API

### Session endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all sessions; connection refused = server not running |
| `POST` | `/api/sessions` | Create session; body `{ id? }`; auto-generates ID if omitted; `409` if ID exists; validates ID rules |
| `GET` | `/api/sessions/:id` | Get single session; `404` if absent |
| `PATCH` | `/api/sessions/:id` | Rename session; body `{ id }`; `409` if new ID exists; `404` if session absent; validates ID rules |
| `DELETE` | `/api/sessions/:id` | Kill PTY, close connected WebSocket, remove session; `204` or `404` |

### Server endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/server/stop` | Graceful shutdown — kills all PTYs, closes WebSocket server, exits |

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Bootstrap | Port `ghostty-web` demo into webtty — full-screen terminal in a browser tab, single server, hardcoded config | [001](../adrs/001.webtty.bootstrap.md) | ⬜ |
| Config file | Load shell, port, font, theme from a config file (`~/.webtty/config.json`) | — | ⬜ |
| In-memory registry | Server-side map of `id → { session, pty }`; sessions survive WS disconnect, not server restart | — | ⬜ |
| Default session | `/` and `/ws` (no session param) use `id = "default"` | — | ⬜ |
| Session URL | `GET /s/:id` — creates session if absent, reconnects if present; same SPA shell | — | ⬜ |
| Session management | CRUD + rename over HTTP — see REST API above | [ADR 004](../adrs/004.webtty.session-api.md) | ⬜ |
| Session client | Multiple browser tabs can attach to the same session simultaneously; reload replays scrollback; typing `exit` closes all tabs | [ADR 007](../adrs/007.webtty.session-client.md) | ⬜ |
