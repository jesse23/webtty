# SPEC: Client Integration (CLI → Web)

**Last Updated:** 2026-06-08

---

## Description

A pattern for pushing live updates from a CLI tool or agent into a browser UI — without running a separate server process.

**Persona:** Developers building CLI agents or tools that produce structured output and want to surface that output in a browser UI in real-time.

**Core idea:** webtty's HTTP server is already running whenever a session is open. A CLI process can `POST` JSON to the session's publish endpoint and any number of browser subscribers receive it immediately over WebSocket — no extra port, no extra process.

**Subscribers here are distinct from terminal clients.** A browser tab that opens the terminal connects to `/ws/:id` (PTY). A browser tab that only needs CLI push-back connects to `/s/:id/subscribe` (channel) and never touches the PTY.

---

## Use Cases

### Agent streaming results to a UI

An AI agent or search tool runs in the terminal and streams structured results (search hits, status updates, progress) to a browser panel that renders them as they arrive.

```
CLI agent  →  POST /s/:id/publish  →  webtty server  →  WS  →  browser panel
```

### Replacing a bespoke sync server

Projects like Fusion today ship a standalone `sync-server.ts` that must be started separately on a dedicated port. The session channel replaces this with two routes on the webtty port that is already running.

---

## Integration Pattern

### 1. Start webtty

```sh
bunx webtty go my-session
```

This is the only process needed. The publish and subscribe endpoints are always-on for every session.

### 2. Subscribe in the browser

```js
const ws = new WebSocket('ws://localhost:2346/s/my-session/subscribe');
ws.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  // render payload in UI
};
```

Each published event arrives as a single WebSocket text frame containing a JSON string. The subscriber does not need to know whether the publisher sent one shot or a long stream — it always receives one complete JSON object per frame.

### 3. Publish from the CLI

The server reads the publish body line by line. Each newline-terminated line is broadcast to subscribers as it arrives. One-shot and streaming are the same endpoint — the only difference is how long the publisher keeps the connection open.

**One-shot** — send one JSON object and close:

```sh
curl -X POST http://localhost:2346/s/my-session/publish \
  -H 'Content-Type: application/json' \
  -d '{"type":"result","items":[...]}'
```

**Streaming** — pipe a long-running agent's output:

```sh
my-agent --stream | curl -X POST http://localhost:2346/s/my-session/publish \
  -H 'Content-Type: application/json' \
  --data-binary @-
```

Or from Node/Bun:

```ts
// one-shot
await fetch('http://localhost:2346/s/my-session/publish', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'status', progress: 0.42 }) + '\n',
});

// streaming — write lines to a ReadableStream as the agent produces them
await fetch('http://localhost:2346/s/my-session/publish', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: readable, // ReadableStream of newline-terminated JSON strings
  duplex: 'half',
});
```

The `204` response is returned after the publisher closes the connection.

---

## Channel Semantics

- **Session-scoped** — one channel per session; the session ID is the channel. No separate creation step.
- **Subscribers ≠ PTY clients** — `session.subscribers` (channel) is a separate set from `session.clients` (PTY terminal). A browser tab can be one, the other, or both.
- **Implicit lifecycle** — the channel is live as long as the session exists. Subscribers can connect and disconnect freely.
- **No persistence** — payloads are not stored or replayed. A subscriber that connects late misses earlier messages.
- **Multiple subscribers** — any number of browser tabs can subscribe simultaneously.
- **Line framing** — the server broadcasts one WS frame per newline-terminated line. Lines that are not valid JSON are silently skipped.

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/s/:id/publish` | Read body line by line; broadcast each valid JSON line to all current subscribers as a discrete WS text frame; `204` after publisher closes; `400` if `Content-Type` is not `application/json`; `404` if session does not exist |
| `GET`  | `/s/:id/subscribe` | WebSocket upgrade — joins `session.subscribers` for the session; receives published payloads as JSON text frames; `404` if session does not exist |

---

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Session channel — publish | `POST /s/:id/publish` reads body line by line; each valid JSON line broadcast to subscribers as a WS frame; `204` on close | [ADR 025](../adrs/025.server.channel.md) | ❌ |
| Session channel — subscribe | `GET /s/:id/subscribe` WebSocket upgrade; joins `session.subscribers`; receives one JSON object per frame | [ADR 025](../adrs/025.server.channel.md) | ❌ |
