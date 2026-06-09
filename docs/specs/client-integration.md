# SPEC: Client Integration (CLI → Web)

**Last Updated:** 2026-06-08

---

## Description

A pattern for pushing live updates from a CLI tool or agent into a browser UI — without running a separate server process.

**Persona:** Developers building CLI agents or tools that produce structured output and want to surface that output in a browser UI in real-time.

**Core idea:** webtty's HTTP server is already running whenever a session is open. Each session has a built-in sidecar channel: a CLI process can `POST` JSON to the session's publish endpoint and any number of browser tabs receive it immediately over WebSocket — no extra port, no extra process, no separate channel name to manage.

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

Each published event arrives as a single WebSocket text frame containing a JSON string.

### 3. Publish from the CLI

**One-shot** — a single JSON object posted in one request:

```sh
curl -X POST http://localhost:2346/s/my-session/publish \
  -H 'Content-Type: application/json' \
  -d '{"type":"result","items":[...]}'
```

**Streaming** — newline-delimited JSON (NDJSON) over a single chunked request; the server broadcasts each line as it arrives:

```sh
my-agent --stream | curl -X POST http://localhost:2346/s/my-session/publish \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @-
```

Or from Node/Bun:

```ts
// one-shot
await fetch('http://localhost:2346/s/my-session/publish', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'status', progress: 0.42 }),
});

// streaming (NDJSON)
const { writable } = new TransformStream();
await fetch('http://localhost:2346/s/my-session/publish', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-ndjson' },
  body: readable, // ReadableStream of newline-terminated JSON strings
});
```

---

## Channel Semantics

- **Session-scoped** — each session has exactly one channel; the session ID is the channel name. No separate channel creation or naming needed.
- **Implicit lifecycle** — the channel is live as long as the session exists. Subscribers can connect and disconnect freely.
- **No persistence** — payloads are not stored or replayed. A subscriber that connects late misses earlier messages (acceptable for live-streaming use cases).
- **Multiple subscribers** — any number of browser tabs can subscribe to the same session channel simultaneously.

---

## API Reference

| Method | Path | Content-Type | Description |
|--------|------|-------------|-------------|
| `POST` | `/s/:id/publish` | `application/json` | Broadcast a single JSON payload to all current subscribers; `204` on success; `400` if body is not valid JSON; `404` if session does not exist |
| `POST` | `/s/:id/publish` | `application/x-ndjson` | Stream NDJSON; each newline-terminated line is parsed and broadcast as it arrives; connection held open until publisher closes it |
| `GET`  | `/s/:id/subscribe` | — | WebSocket upgrade — joins the subscriber set for the session; receives published payloads as JSON text frames; `404` if session does not exist |

---

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Session channel — one-shot publish | `POST /s/:id/publish` with `application/json` broadcasts a single event to all WebSocket subscribers | [ADR 025](../adrs/025.server.channel.md) | ❌ |
| Session channel — streaming publish | `POST /s/:id/publish` with `application/x-ndjson` broadcasts each line as it arrives | [ADR 025](../adrs/025.server.channel.md) | ❌ |
| Session channel — subscribe | `GET /s/:id/subscribe` WebSocket upgrade; receives published events as discrete frames | [ADR 025](../adrs/025.server.channel.md) | ❌ |
