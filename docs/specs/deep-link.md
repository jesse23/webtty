# SPEC: Deep Link

**Last Updated:** 2026-04-05 (amended: reorganized, PID-based API, 3rd party integration)

---

## Scope and Plan

### Problem

Two related problems:

1. **Duplicate tabs** — `webtty go <id>` opens a new browser tab every time. If the session is already open, the user ends up with two identical tabs.
2. **No PID-based navigation** — Third-party tools (e.g. Vibe Island) track AI agent processes by PTY shell PID, not by session name. They have no way to map a PID to a webtty session or navigate directly to it.

### What this spec covers

| Area | Change |
|------|--------|
| Client | BroadcastChannel focus handshake — focus existing tab instead of opening a duplicate |
| Server API | Expose `pid` in `GET /api/sessions` response |
| Server routing | `GET /p/<pid>` — redirect to the session that owns that PTY PID |

### Out of scope

- `webtty://` custom URL scheme — requires a native app bundle (`Info.plist`). webtty is an npm CLI with no bundle. Documented as a future path in the [3rd Party Integration](#3rd-party-integration) section.
- CLI changes — `webtty go <id>` is unchanged. Focus logic is entirely client-side.
- SSE event stream — out of scope for this spec; the WebSocket already serves real-time output.

---

## Inspection

> Research findings that inform the design decisions above.

### How Vibe Island works

[Vibe Island](https://vibeisland.app) is a native macOS app that sits in the notch and monitors AI coding agents (Claude Code, OpenCode, Gemini CLI, Cursor, etc.). When a task completes, it sends a macOS notification. Clicking it jumps to the exact terminal tab where the agent ran.

The integration model varies by tool:

| Tool | How Vibe Island connects | How "jump" works |
|------|--------------------------|------------------|
| Claude Code | Hook entries written to `~/.claude/settings.json`; local Unix socket bridge | PID matching via macOS Accessibility API |
| Cursor | Hook entries written to `~/.cursor/hooks.json` | VSIX extension receives `cursor://vibeisland/jump?pid=<pid>`, walks `vscode.window.terminals`, matches `terminal.processId` |
| Gemini CLI | Hook entries written to `~/.gemini/settings.json`; Unix socket bridge | PID matching |
| OpenCode | HTTP SSE event stream — no hook injection needed | PID matching + port discovery |

### The PID-based jump mechanism (VS Code/Cursor VSIX)

Vibe Island's Cursor/VS Code extension:

```js
vscode.window.registerUriHandler({
  async handleUri(uri) {
    const params = new URLSearchParams(uri.query);
    const pids = params.getAll('pid').map(p => parseInt(p, 10));

    for (const terminal of vscode.window.terminals) {
      const termPid = await terminal.processId;
      if (pids.includes(termPid)) {
        terminal.show(false);  // focus the tab
        return;
      }
    }
  }
});
```

Vibe Island knows the **shell PID** of each agent process from its monitoring hooks. On jump, it opens `cursor://vibeisland/jump?pid=12345`. The extension walks all open terminals, matches the PTY shell PID, and focuses the right one.

### The gap for webtty

webtty's current `GET /api/sessions` response is:

```json
[{ "id": "main", "createdAt": 1700000000000, "connected": true }]
```

The PTY PID is never exposed. Vibe Island cannot map a shell PID to a webtty session, and therefore cannot construct the jump URL `http://127.0.0.1:PORT/s/<id>`.

Both PTY backends already have the PID available:
- **node-pty**: `ptyProc.pid` (property on `IPty`)
- **Bun**: `proc.pid` (property on `Bun.spawn` result)

It just needs to be surfaced through `PtyProcess`, `Session`, and `sessionToJson`.

### Port discovery

Vibe Island discovers running OpenCode instances via "multi-layer port discovery" (their phrasing). OpenCode's HTTP server starts automatically as part of normal operation — there is no separate `serve` command to opt into. The exact discovery mechanism is not published, but the likeliest approach is trying a known default port then falling back to a port range scan. webtty uses a fixed default port (`2346`) and respects the `PORT` env var — the same convention works with port-scan-based discovery.

### BroadcastChannel (focus-existing-tab)

The browser cannot focus an existing tab from outside. The only same-origin mechanism is `BroadcastChannel`: a new tab loading `/s/<id>` posts a focus-request; the existing tab for that session receives it, calls `window.focus()`, and acks; the new tab shows a fallback UI instead of mounting a second terminal to the same PTY.

Constraints:
- `window.close()` is blocked for tabs not opened by script — the new tab cannot self-close when opened via `open <url>` on macOS. Show a "Session already open in another tab" message instead.
- `window.focus()` on macOS raises the window but browser security policy may not switch tabs without a user gesture. Best-effort — no workaround without a native helper.

### macOS URL scheme — future path

iTerm2 registers `iterm2://` via `CFBundleURLTypes` in `Info.plist`. VS Code registers `vscode://` the same way. Both are native app bundles.

webtty is an npm CLI — no `Info.plist`, no bundle. A `webtty://` scheme would require a small native shim (Electron or Swift) that registers the protocol and proxies to the local server. This would unlock notification-click → open-webtty without going through a browser URL bar. Deferred — the `http://` URL is sufficient for now.

---

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Focus existing tab | New tab loading `/s/<id>` checks via BroadcastChannel whether that session is already open; if so, focuses the existing tab and shows a fallback UI | — | ⬜ |
| PID in session API | `GET /api/sessions` includes `pid: number \| null` per session (null before first WS connection spawns the PTY) | — | ⬜ |
| PID-based navigation | `GET /p/<pid>` — server looks up the session owning that PTY PID and 302-redirects to `/s/<id>`; 404 if no match | — | ⬜ |

### Focus existing tab — detail

**Client changes** (`src/client/index.ts`):

On page load, open a `BroadcastChannel` named `webtty:focus:<sessionId>` and run the handshake before mounting the terminal:

```
// 1. Post focus-request immediately on load
channel.postMessage({ type: 'focus-request', sessionId });

// 2. Wait up to 200ms for focus-ack from an existing tab
//    → if ack received: show "Session already open in another tab" UI, skip terminal mount
//    → if no ack: mount terminal normally (this is the first tab)

// 3. Also listen for incoming focus-requests (this tab is already open)
channel.onmessage = (e) => {
  if (e.data.type === 'focus-request') {
    window.focus();
    channel.postMessage({ type: 'focus-ack' });
  }
};
```

**Server changes**: none.

### PID in session API — detail

**`PtyProcess` interface** (`src/pty/types.ts`): add `pid: number`.

**Backends**:
- `src/pty/node.ts`: return `pid: ptyProc.pid`
- `src/pty/bun.ts`: return `pid: proc.pid`

**`Session`** (`src/server/session.ts`): no change to the Session struct — `pty.pid` is read directly from the PtyProcess when serializing.

**`sessionToJson`**: include `pid: s.pty?.pid ?? null`.

**API response** (updated shape):

```json
[{ "id": "main", "createdAt": 1700000000000, "connected": true, "pid": 12345 }]
```

`pid` is `null` if the PTY has not been spawned yet (session created but no WebSocket client has connected).

### PID-based navigation — detail

**New server route** (`src/server/routes.ts`):

```
GET /p/<pid>
```

1. Parse `<pid>` as integer; return 404 if not a valid positive integer
2. Walk `sessionRegistry`, find the session where `session.pty?.pid === pid`
3. If found: 302 redirect to `/s/<session.id>`
4. If not found: 404

This is the URL Vibe Island (or any tool) opens to jump to a webtty session by PID, without needing to know the session ID:

```
open http://127.0.0.1:2346/p/12345
```

The redirect lands on `/s/main` (or whichever session owns PID 12345), and the BroadcastChannel focus handshake brings the existing tab forward.

### 3rd Party Integration

With the above three features in place, tools like Vibe Island can integrate with webtty with no changes on their side beyond recognising webtty as a target:

| Action | How |
|--------|-----|
| Discover running webtty | `GET http://127.0.0.1:2346/api/sessions` — 200 + JSON array means running |
| List sessions with PIDs | Same endpoint — returns `[{ id, createdAt, connected, pid }]` |
| Watch session output | WebSocket `ws://127.0.0.1:2346/ws/<id>?cols=80&rows=24` |
| Jump by session ID | `open http://127.0.0.1:2346/s/<id>` |
| Jump by PTY PID | `open http://127.0.0.1:2346/p/<pid>` — server redirects to the right session |
| Custom port | Respect `PORT` env var; default `2346` |

**No Unix socket bridge, no config file injection, no hook setup.** The REST API + PID-based redirect + BroadcastChannel focus is the complete integration surface.
