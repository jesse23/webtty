# SPEC: webtty

**Author:** jesse23
**Last Updated:** 2026-03-21

---

## Description

webtty is a web TTY that lets you run CLI/TUI applications in a browser tab, on any platform. Point a browser at a running webtty server and you get a full terminal — colors, cursor, resize, keyboard input — backed by a real PTY on the host machine.

The goal is the same as ttyd and GoTTY: zero client-side installation, full TUI support, cross-platform. webtty uses `ghostty-web` as the terminal renderer (WASM-backed, same API as xterm.js) and `@lydell/node-pty` for cross-platform PTY support.

**Why a single-port design?** Simplifies reverse proxy setup (nginx, ngrok, Cloudflare Tunnel) — one upstream, no separate port for assets vs API vs WebSocket. Same pattern used by ttyd and ghostty-web/demo.

**Why `ws` over Socket.IO?** Minimal footprint, no client-side library requirement, sufficient for raw PTY streaming. Socket.IO's rooms/namespaces are unnecessary overhead for this use case.

**Persona:** Developers who want shell or TUI app access from any browser tab.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Bootstrap | Port `ghostty-web` demo into webtty — full-screen terminal in a browser tab, single server, hardcoded config | [001](../adrs/001.webtty.bootstrap.md) | ⬜ |
| Config file | Load shell, port, font, theme from a config file (`~/.webtty/config.json`) | — | ⬜ |
| Named sessions | Session registry keyed by ID; create/locate via `/ws?session=<id>`; PTY survives WebSocket disconnect | — | ⬜ |
| Session REST API | `GET /api/sessions`, `POST /api/sessions`, `DELETE /api/sessions/:id` | — | ⬜ |
| Server control API | `POST /api/server/restart`, `POST /api/server/stop` | — | ⬜ |
| Health endpoint | `GET /health` — returns 200 + uptime/version; used by CLI for daemon lifecycle checks | — | ⬜ |
| UI | Browser interface for terminal, session management, and server control | — | ⬜ |
| CLI | `webtty` binary for server lifecycle and session management | — | ⬜ |
