# SPEC: CLI

**Author:** jesse23
**Last Updated:** 2026-03-24 (amended: help formatting, ls filter, restart removed, at/mv commands, isServerRunning validation, stop-on-last-rm)

---

## Description

The `webtty` CLI controls a running webtty server over HTTP. It handles two concerns: server lifecycle (`start` / `stop`) and session management (attach, list, remove, rename sessions).

The CLI communicates with the server exclusively over HTTP — no Unix sockets, no PID files. Whether the server is running is determined by a single question: does `GET /api/sessions` respond with a JSON array? Connection refused (or a non-webtty process on the same port) means not running.

## Commands

| Command | Description |
|---------|-------------|
| `webtty at [id]` | Start server if not running; attach to session (creates if new, reuses if exists); open in browser. Aliases: `a`, `attach` |
| `webtty ls [id]` | `GET /api/sessions` — list sessions; if `[id]` given, filter by substring match. Alias: `list` |
| `webtty rm [id]` | `DELETE /api/sessions/:id` — destroy session and its PTY; stops server if last session. Alias: `remove` |
| `webtty mv [id] [new-id]` | `PATCH /api/sessions/:id` — rename a session. Aliases: `move`, `rename` |
| `webtty stop` | `POST /api/server/stop` — server cleans up and exits |
| `webtty start` | Fork server, wait for `GET /api/sessions` to respond |
| `webtty` | No-arg entry point — start server if not running, then delegate to `webtty at main` |
| `webtty config` | Open `~/.config/webtty/config.json` in `$VISUAL` (falls back to `$EDITOR`, then `vi` on Unix / `notepad` on Windows) |
| `webtty help` | Show help — all commands |

## No-arg entry point

`webtty` with no arguments:

1. Start the server if not already running
2. Delegate to `webtty at main` — create or reuse the `main` session and open it in the browser

This is the canonical quickstart: `npx webtty` or `bunx webtty` goes from zero to a browser terminal in one command.

## Help command

`webtty help` prints all commands. The `-h` / `--help` flag is not advertised but still works if users reach for it.

This makes the welcome banner's call-to-action (`Run \`bunx webtty help\` for more information.`) functional.

## Config command

`webtty config` opens `~/.config/webtty/config.json` in the user's preferred editor:

1. Resolve editor: `$VISUAL` → `$EDITOR` → `vi` (Unix) / `notepad` (Windows)
2. Ensure the config file exists (first-run write happens on server startup, but `webtty config` may run before the server has ever started)
3. Spawn the editor with the config path, inheriting stdio so the terminal is fully handed off

The command exits when the editor exits.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Server lifecycle | `webtty start` / `stop` — start and stop the server | [ADR 002](../adrs/002.cli.start-stop.md) | ✅ |
| Session management | `webtty at` / `ls` / `rm` / `mv` — attach, list, destroy, and rename sessions | [ADR 006](../adrs/006.cli.session-management.md) | ✅ |
| No-arg entry point | `webtty` — start server and open `main` session in browser | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Help and config | `webtty help` — show all commands; `webtty config` — open config in `$VISUAL`/`$EDITOR`/`vi` | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Help formatting | Description first, all-caps headings, aligned params, frequency-ordered commands, annotated usage lines | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Stop on last rm | `webtty rm` auto-stops the server when the last session is removed | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
