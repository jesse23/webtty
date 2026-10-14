# SPEC: webtty

**Last Updated:** 2026-10-13

---

## Description

webtty runs CLI/TUI applications in a browser tab. Point a browser at a running webtty server and you get a full terminal — colors, cursor, resize, keyboard input — backed by a real PTY on the host machine.

The goal is zero client-side installation and full TUI support on any platform. webtty emulates the terminal with Ghostty's official libghostty-vt (WebAssembly, vendored and signature-checked), draws it with a canvas renderer and input layer derived from ghostty-web (vendored and maintained in this repo; see ADR 041 and ADR 047), and uses `@lydell/node-pty` for cross-platform PTY support.

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

### Output flow control

PTY output is paced per client by acknowledgements (ADR 048). A client that connects with `?flow=1` sends `{"type":"ack","chars":<total>}` as it parses output: the running count of characters (UTF-16 code units) since it connected, every 64 Ki characters and 100 ms after output stops.

| Rule | Value |
|------|-------|
| Client blocked (new output queued in order) | 2 Mi characters unacknowledged |
| Client unblocked (queue sent, coalesced into ≤ 64 Ki-character messages) | 512 Ki characters unacknowledged |
| PTY paused | while every client is blocked, if the PTY can pause (node-pty; `Bun.Terminal` cannot) |
| Client closed with `4003` (fell behind; it reconnects and gets the replay) | queue over 16 Mi characters |
| Legacy client (no `?flow=1`) | sent straight through; closed with `4003` once `bufferedAmount` passes 8 MB (under Bun the close frame is stuck behind the shim's 16 MB backlog and the tab sees `1006`; either way it reconnects to the replay) |

Scrollback replay and the banner count against the same window, sent in pieces of up to 64 Ki characters; what the replay queues is allowed on top of the 16 Mi limit. When the shell exits, each client is sent what is still queued for it, as its acknowledgements allow, before it is closed with `4001`; one that sends no acknowledgement for 2 s is closed at once. Frames are text frames.

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
| `POST` | `/api/sessions` | Create session; body `{ id?, baseDir? }`; auto-generates ID if omitted; `409` if ID exists; validates ID rules; `baseDir` must be an absolute path that exists on disk (default: `homedir()`) |
| `GET` | `/api/sessions/:id` | Get single session; `404` if absent |
| `PATCH` | `/api/sessions/:id` | Rename session; body `{ id }`; `409` if new ID exists; `404` if session absent; validates ID rules |
| `DELETE` | `/api/sessions/:id` | Kill PTY, close connected WebSocket, remove session; `204` with `X-Sessions-Remaining: <n>` header, or `404` |

### Server endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/server/status` | Server status; responds `200` with `{ version }` — the `package.json` version (`0.0.0-development` in dev checkouts) |
| `POST` | `/api/server/stop` | Graceful shutdown — kills all PTYs, closes WebSocket server, exits |

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Bootstrap | Full-screen terminal in a browser tab, single server, config-driven | [ADR 001](../adrs/001.webtty.bootstrap.md) | ✅ |
| Session management | Create, list, rename, and delete sessions over HTTP; sessions survive WebSocket disconnects but not server restarts | [ADR 004](../adrs/004.webtty.session-api.md) | ✅ |
| Default session | `GET /` redirects to last-used session, or creates `main` if none exists | — | ✅ |
| Multi-client sessions | Multiple browser tabs can attach to the same session; PTY output broadcast to all; scrollback replayed on reconnect | [ADR 007](../adrs/007.webtty.session-client.md) | ✅ |
| Config file | Shell, port, font, theme from `~/.config/webtty/config.json`; hot-reload on tab reload | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Client integration (CLI → Web) | `POST /s/:id/publish` (one-shot or streaming JSON) + `ws /ws/:id/events` subscribe; channel active only while PTY is running; no extra process or port | [ADR 025](../adrs/025.server.channel.md) | ✅ |
| Session base directory | `POST /api/sessions` accepts `baseDir` (absolute path); PTY shell spawns there instead of `homedir()`; CLI `webtty [go] [id] --dir <path>` resolves and forwards it; ignored when attaching to an existing session | [ADR 028](../adrs/028.session.base-dir.md) | ✅ |
| Output flow control | Output paced per client by acknowledgements: in order at any client speed, bounded server buffers, PTY paused while every client is behind (node-pty), a client that falls 16 Mi characters behind is closed with `4003` and reconnects to the replay; avoids Bun's `ws` shim reordering and duplicating messages past 16 MB | [ADR 048](../adrs/048.webtty.output-flow-control.md) | ✅ |
