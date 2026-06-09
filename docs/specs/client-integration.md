# SPEC: Client Integration (CLI → Web)

**Last Updated:** 2026-06-08

---

## Description

A pattern for pushing live updates from a CLI tool or agent into a browser UI — without running a separate server process.

**Persona:** Developers building CLI agents or tools that produce structured output and want to surface that output in a browser UI in real-time.

**Core idea:** webtty's HTTP server is already running whenever a terminal session is open. A named pub/sub channel piggybacks on that server so any CLI process can `POST` a JSON payload and any number of browser tabs receive it immediately over WebSocket — no extra port, no extra process.

---

## Use Cases

### Agent streaming results to a UI

An AI agent or search tool runs in the terminal and streams structured results (search hits, status updates, progress) to a browser panel that renders them as they arrive.

```
CLI agent  →  POST /channel/my-agent/publish  →  webtty server  →  WS  →  browser panel
```

### Replacing a bespoke sync server

Today, projects like Fusion ship a standalone `sync-server.ts` that must be started separately on a dedicated port. The client-integration channel replaces this with two routes on the webtty port that is already running.

---

## Integration Pattern

### 1. Start webtty

```sh
bunx webtty go my-session
```

This is the only process needed. The channel endpoints are always-on.

### 2. Subscribe in the browser

```js
const ws = new WebSocket('ws://localhost:2346/channel/my-agent/subscribe');
ws.onmessage = (e) => {
  const payload = JSON.parse(e.data);
  // render payload in UI
};
```

### 3. Publish from the CLI

From a shell script, agent, or MCP tool:

```sh
curl -X POST http://localhost:2346/channel/my-agent/publish \
  -H 'Content-Type: application/json' \
  -d '{"type":"result","items":[...]}'
```

Or from Node/Bun:

```ts
await fetch('http://localhost:2346/channel/my-agent/publish', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'status', progress: 0.42 }),
});
```

---

## Channel Semantics

- **Implicit lifecycle** — channels are created on first subscriber and torn down when the last subscriber disconnects. No create/delete API.
- **No persistence** — payloads are not stored or replayed. A subscriber that connects late misses earlier messages (acceptable for live-streaming use cases).
- **Multiple channels** — use distinct names (e.g. `search`, `agent-status`) so independent features on the same webtty instance don't interfere.
- **Channel names** — `a-z`, `0-9`, `-`, `_`, `.`, 1–64 characters (same rules as session IDs).

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/channel/:name/publish` | Broadcast a JSON payload to all current subscribers; `204` on success; `400` if body is not valid JSON; `415` if `Content-Type` is not `application/json` |
| `GET`  | `/channel/:name/subscribe` | WebSocket upgrade — joins the subscriber set for `:name`; receives published payloads as JSON text frames |

---

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Named pub/sub channel | POST publish + WebSocket subscribe on the existing webtty server | [ADR 025](../adrs/025.server.channel.md) | ❌ |
