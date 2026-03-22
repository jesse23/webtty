# SPEC: CLI

**Author:** jesse23
**Last Updated:** 2026-03-21

---

## Description

The `webtty` CLI is a thin client that controls a running webtty server over HTTP. It handles two concerns: server lifecycle (start/stop/restart the daemon) and session management (create/list/kill sessions via the REST API).

The CLI communicates with the server exclusively over HTTP to localhost — no Unix sockets, no direct process management beyond the startup fork. A PID file (`~/.webtty/server.pid`) is the source of truth for whether a daemon is running; a `/health` HTTP check confirms it is actually responsive.

**Why HTTP over Unix socket?** webtty already speaks HTTP — reusing the same interface keeps the surface area minimal and makes the CLI trivially debuggable with `curl`. Unix sockets offer lower latency but the difference is imperceptible for CLI interactions.

**Why Commander.js?** Zero dependencies, 18ms startup, TypeScript-native, used by Vue CLI and Vite. Yargs and oclif are heavier and provide features (plugin systems, config files) that are unnecessary here.

**Why PID file + health check vs port probe alone?** A port probe can give false positives (another process on the same port). PID file + signal 0 check + HTTP health check gives reliable daemon detection with graceful handling of stale PID files.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Server lifecycle | `webtty start`, `webtty stop`, `webtty restart`, `webtty status` — daemon control via PID file + HTTP | [ADR 002](../adrs/002.cli.start-stop.md) | ⬜ |
| Session management | `webtty session create/list/kill` — thin wrappers over the session REST API | — | ⬜ |
