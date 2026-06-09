# SPEC: channel

**Last Updated:** 2026-06-08

---

## Description

A named pub/sub channel built into the webtty server. Any process can push a JSON payload to a named channel via HTTP; any number of WebSocket subscribers receive it in real-time.

**Persona:** Developers who want to pipe structured output from a CLI agent/tool into a browser UI without running a separate server process.

**Key property:** the channel is always-on — it piggybacks on the existing webtty server with no extra port or process. Running `bunx webtty go <session>` is sufficient.

## Channel model

Channels are ephemeral and implicit — they are created on first subscribe and destroyed when the last subscriber disconnects. There is no persistent state; payloads are not stored or replayed.

```typescript
// Server-side (internal)
channels: Map<string, Set<WebSocket>>
```

Channel names follow the same rules as session IDs: `a-z`, `0-9`, `-`, `_`, `.`, 1–64 characters.

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/channel/:name/publish` | Push a JSON payload to all subscribers of `:name`; `204` on success; `400` if body is not valid JSON; `415` if `Content-Type` is not `application/json` |
| `GET`  | `/channel/:name/subscribe` | WebSocket upgrade — joins the subscriber set for `:name`; server sends published payloads as JSON strings |

### Publish request

```
POST /channel/fusion-sync/publish
Content-Type: application/json

{ "type": "search-result", "items": [...] }
```

Response: `204 No Content`

### Subscribe (WebSocket)

```
ws://localhost:2346/channel/fusion-sync/subscribe
```

Each published payload arrives as a single WebSocket text frame containing the JSON string.

## Usage

Start webtty as usual:

```sh
bunx webtty go my-session
```

From an agent or CLI tool, push results:

```sh
curl -X POST http://localhost:2346/channel/fusion-sync/publish \
  -H 'Content-Type: application/json' \
  -d '{"type":"result","data":[...]}'
```

A browser UI subscribes via WebSocket:

```js
const ws = new WebSocket('ws://localhost:2346/channel/fusion-sync/subscribe');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Named pub/sub channel | POST publish + WebSocket subscribe on the existing webtty server | [ADR 025](../adrs/025.server.channel.md) | ❌ |
