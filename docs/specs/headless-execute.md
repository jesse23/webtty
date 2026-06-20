# SPEC: Server — Execute Mode (CLI → HTTP)

**Last Updated:** 2026-06-11

---

## Description

A session-scoped HTTP endpoint that runs a CLI command non-interactively and streams its output back to the caller.

**Persona:** Browser-based tools, web UIs, and scripts that need to invoke a local CLI (e.g. `claude -p`) and consume the output — without going through an interactive terminal session.

Execute is the headless companion to the interactive terminal. A session in webtty groups three modes:

| Mode | How |
|------|-----|
| Interactive terminal | Browser connects via WebSocket, drives the PTY live |
| Execute (headless) | Caller POSTs a command, receives streamed output |
| Publish channel | Agent/script pushes structured output to subscribers |

---

## Architecture

```
┌─────────────────┐   WS /ws/:id/pty                   ┌──────────────────────┐
│  Browser tab    │ ◄──────────────────────────────── │                      │
│  (terminal)     │ ──────────────────────────────── ►│   session PTY        │
└─────────────────┘   keyboard / resize                │                      │
                                                        │   webtty server      │
┌─────────────────┐   POST /s/:id/execute              │                      │
│  Browser /      │  { cmd, args, stdin? }             │   child_process      │
│  fetch client   │ ──────────────────────────────── ►│   .spawn(cmd, args)  │
│                 │  application/x-ndjson (chunked)    │                      │
│  ReadableStream │ ◄────────────────────────────── - │                      │
│  (stdout/exit)  │  {"stream":"stdout","data":"…"}    │                      │
└─────────────────┘  {"exit":0}                        └──────────────────────┘
```

Execute spawns a separate child process (not the PTY). The PTY must be running (`409` otherwise) but the command runs independently alongside it.

---

## Use Cases

### Run `claude -p` from a browser UI

A web panel sends a prompt to `claude -p` and renders the streaming markdown response as it arrives — no terminal emulator required, no WebSocket to manage.

### Programmatic CLI invocation

Any browser-based tool (extension, localhost web app) that needs to call a local CLI and consume structured output in the context of a running session.

---

## How It Works

1. Caller sends `POST /s/:id/execute` with JSON body: `{ "cmd": "claude", "args": ["-p", "…"] }`
2. Server checks session exists (`404` if not) and PTY is running (`409` if not)
3. Server spawns the command via `child_process.spawn` (no PTY — plain piped stdio)
4. stdout chunks are flushed as ndjson lines: `{"stream":"stdout","data":"…"}`
5. stderr chunks (if any): `{"stream":"stderr","data":"…"}`
6. On process exit: `{"exit":0}` — then response ends
7. If the request is cancelled mid-stream, the child process is killed

For API reference and design rationale see [ADR 026](../adrs/026.server.headless-execute.md).

---

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Execute endpoint | `POST /s/:id/execute` — spawn a CLI command alongside a running session, stream stdout/stderr as ndjson, close with exit code | [ADR 026](../adrs/026.server.headless-execute.md) | ✓ |
| Execute resilience & structured errors | Process-level crash guards; `child.on('error')` handler; exit line carries `error`+`code` on spawn failure so agents can branch without parsing stderr text | [ADR 027](../adrs/027.server.execute-resilience.md) | ✓ |
