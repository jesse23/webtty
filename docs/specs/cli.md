# SPEC: CLI

**Author:** jesse23
**Last Updated:** 2026-03-22

---

## Description

The `webtty` CLI is a thin client that controls a running webtty server over HTTP. It handles two concerns: server lifecycle (start/stop/restart the server) and session management (create/list/remove/rename sessions via the REST API).

The CLI communicates with the server exclusively over HTTP to localhost — no Unix sockets, no PID files, no process signals. Whether the server is running is determined by a single question: does `GET /api/sessions` respond? Connection refused means not running. This works identically on Mac, Linux, and Windows.

**Why HTTP over Unix socket?** webtty already speaks HTTP — reusing the same interface keeps the surface area minimal and makes the CLI trivially debuggable with `curl`. Unix sockets offer lower latency but the difference is imperceptible for CLI interactions.

**Why Commander.js?** Zero dependencies, 18ms startup, TypeScript-native, used by Vue CLI and Vite. Yargs and oclif are heavier and provide features (plugin systems, config files) that are unnecessary here.

**Why no PID file?** PID files require platform-specific signal handling (`SIGTERM` on Unix, `TerminateProcess` on Windows) and go stale if the server crashes. HTTP-only detection is simpler, cross-platform, and sufficient — the server owns its own shutdown via `POST /api/server/stop`.

## Commands

| Command | Description | Done? |
|---------|-------------|-------|
| `webtty start` | Fork server, wait for `GET /api/sessions` to respond | ⬜ |
| `webtty stop` | `POST /api/server/stop` — server cleans up and exits | ⬜ |
| `webtty ls` | `GET /api/sessions` — print server status (running/stopped) and all sessions (id, connected); connection refused = stopped | ⬜ |
| `webtty run [id]` | `POST /api/sessions` — create session, auto-generates ID if omitted, then opens the session URL in the default browser | ⬜ |
| `webtty rm <id>` | `DELETE /api/sessions/:id` — kill session and its PTY | ⬜ |
| `webtty rename <id> <new-id>` | `PATCH /api/sessions/:id` — rename a session; session URL updates to reflect new id | ⬜ |
| `webtty restart` | Stop + start | ⬜ |

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Server lifecycle | `webtty start` / `stop` — fork, detect, and terminate the server over HTTP | [ADR 002](../adrs/002.cli.start-stop.md) | ⬜ |
| Session management | `webtty run` / `ls` / `rm` / `rename` — create, list, remove, and rename sessions via the REST API | — | ⬜ |
| Server restart | `webtty restart` — stop then start; `POST /api/server/restart` on server side | — | ⬜ |
