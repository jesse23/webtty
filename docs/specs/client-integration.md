# SPEC: Client Integration (CLI → Web)

**Last Updated:** 2026-06-08

---

## Description

A pattern for pushing live updates from a CLI tool or agent into a browser UI — without running a separate server process.

**Persona:** Developers building CLI agents or tools that produce structured output and want to surface that output in a browser UI in real-time.

webtty's HTTP server is already running whenever a session is open. The integration channel piggybacks on that server so any CLI process can publish structured events and any number of browser tabs receive them instantly — no extra port, no extra process.

---

## Architecture

```
┌─────────────────┐        POST /s/:id/publish        ┌──────────────────────┐
│   CLI / Agent   │ ────────────────────────────────► │                      │
│  (publisher)    │                                    │   webtty server      │
└─────────────────┘                                    │                      │
                                                       │  session.subscribers │
┌─────────────────┐        ws /s/:id/subscribe         │                      │
│  Browser panel  │ ◄───────────────────────────────── │                      │
│  (subscriber)   │      one WS frame per event        │                      │
└─────────────────┘                                    └──────────────────────┘

┌─────────────────┐        ws /ws/:id  (PTY)           ┌──────────────────────┐
│  Browser tab    │ ◄───────────────────────────────── │                      │
│  (terminal)     │ ────────────────────────────────►  │   session.clients    │
└─────────────────┘        keyboard / resize           └──────────────────────┘
```

Subscribers (integration channel) and terminal clients (PTY) are independent. A browser tab can be one, the other, or both.

---

## Use Cases

### Agent streaming results to a UI

An AI agent or search tool runs in the terminal and emits structured results — search hits, status updates, token streams — that a browser panel renders as they arrive. The agent publishes to the session channel; the browser subscribes.

### Replacing a bespoke sync server

Projects like Fusion today ship a standalone `sync-server.ts` on a separate port that must be started independently. The session channel replaces it: one webtty process, one port, zero extra setup.

---

## How It Works

1. `bunx webtty go my-session` — the only process to start; publish and subscribe endpoints are available immediately
2. Browser panels subscribe via WebSocket on the session's subscribe endpoint
3. CLI tools or agents POST JSON to the session's publish endpoint — one-shot or as a stream of lines
4. Each JSON line is broadcast to all subscribers as a discrete WebSocket frame as it arrives

For interface details, channel flow, and API reference see [ADR 025](../adrs/025.server.channel.md).

---

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Session channel — publish | CLI tools POST JSON (one-shot or streaming) to the session; each event broadcast to subscribers in real-time | [ADR 025](../adrs/025.server.channel.md) | ❌ |
| Session channel — subscribe | Browser panels subscribe via WebSocket and receive one JSON object per frame | [ADR 025](../adrs/025.server.channel.md) | ❌ |
