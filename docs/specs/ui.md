# SPEC: UI

**Author:** jesse23
**Last Updated:** 2026-03-21

---

## Description

The wtty web UI is served by the wtty server and runs entirely in the browser. It has two surfaces: a terminal view (full-viewport, one session per tab) and a session manager (list, create, open, kill sessions, and control the server).

The UI has no build step in the initial slices — plain HTML + `<script type="module">` importing `ghostty-web` assets served by the server itself. A bundler can be introduced later if the UI grows beyond a handful of files.

**Why ghostty-web over xterm.js?** ghostty-web is the reference implementation for this project, already available locally, and shares the same `Terminal` / `FitAddon` API shape as xterm.js. xterm.js is the safer long-term bet (wider ecosystem, VS Code backing) but ghostty-web is sufficient for the initial slices and avoids an early dependency decision.

**Why no framework (React/Vue) yet?** The session manager UI is simple enough (a table + buttons) that a framework adds more complexity than it removes. Revisit when the UI grows.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Terminal view | Full-viewport terminal using `ghostty-web`, auto-fit, reconnect on disconnect | [001](../adrs/001.wtty.bootstrap.md) | ⬜ |
| Session manager | List sessions, open in new tab, create new session, kill session | — | ⬜ |
| Server control | Restart and stop server from the UI (calls server control API) | — | ⬜ |
