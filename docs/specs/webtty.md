# SPEC: webtty

**Last Updated:** 2026-03-24

---

## Description

webtty runs CLI/TUI applications in a browser tab. Point a browser at a running webtty server and you get a full terminal — colors, cursor, resize, keyboard input — backed by a real PTY on the host machine.

The goal is zero client-side installation and full TUI support on any platform. webtty uses `ghostty-web` as the terminal renderer (WASM-backed, same API as xterm.js) and `@lydell/node-pty` for cross-platform PTY support.

**Persona:** Developers who want shell or TUI app access from any browser tab.

## Sessions

Sessions are PTY instances keyed by ID. Each session has a unique ID and a running PTY process. Sessions survive WebSocket disconnects but not server restarts (memory-only — webtty defers long-lived persistence to `tmux`/`screen`).

New sessions use the shell configured in `~/.config/webtty/config.json` (defaults to `$SHELL` on POSIX, `%COMSPEC%` on Windows). No per-session command override.

### Session data model

```typescript
interface Session {
  id: string;         // URL-safe identifier (user-supplied or auto-generated)
  createdAt: number;  // Unix timestamp ms
  connected: boolean; // Whether at least one WebSocket client is currently attached
}
```

### Session lifecycle

```
                    WS connect                WS connect (more clients)
                   (PTY spawns)               (scrollback replayed)
                       │                             │
  POST /api/sessions   │   all clients disconnect    │
  ────────────────► [idle] ◄──────────────────── [active] ──► [active]
                       │                            │         clients: 1..N
                       │                            │
                       └──────────┬─────────────────┘
                                  │ DELETE / server stop / shell exit
                                  ▼
                              [removed]
```

Sessions survive client disconnects — the PTY keeps running while idle. Multiple clients can attach to the same session simultaneously; PTY output is broadcast to all.

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
| `DELETE` | `/api/sessions/:id` | Kill PTY, close connected WebSocket, remove session; `204` with `X-Sessions-Remaining: <n>` header, or `404` |

### Server endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/server/stop` | Graceful shutdown — kills all PTYs, closes WebSocket server, exits |

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Bootstrap | Full-screen terminal in a browser tab, single server, config-driven | [ADR 001](../adrs/001.webtty.bootstrap.md) | ✅ |
| Session management | Create, list, rename, and delete sessions over HTTP; sessions survive WebSocket disconnects but not server restarts | [ADR 004](../adrs/004.webtty.session-api.md) | ✅ |
| Default session | `GET /` redirects to last-used session, or creates `main` if none exists | — | ✅ |
| Multi-client sessions | Multiple browser tabs can attach to the same session; PTY output broadcast to all; scrollback replayed on reconnect | [ADR 007](../adrs/007.webtty.session-client.md) | ✅ |
| Config file | Shell, port, font, theme from `~/.config/webtty/config.json`; hot-reload on tab reload | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
