# Awesome Web

A personal guide to living in the browser.

## Why the Browser

The browser is where you already spend your time. One window manager, sync across devices, no install friction. The web platform caught up — most apps you need actually run well in it now.

You don't need a native app for everything. Seriously. The browser handles email, documents, spreadsheets, code editing, terminals, and design tools. Pick a browser, set it up right, and you've got a complete computing environment that works on any device.

## Best Practices

### Browser Choice

Pick one, stick with it. Cross-device sync matters more than features.

| Browser | Why Pick It |
|---------|------------|
| **[Vivaldi](https://vivaldi.com)** | Most customizable — hide the address bar entirely for a minimal, distraction-free UI |
| **[Arc](https://arc.net)** | Minimal by default — no tab bar, no address bar, sidebar-first |
| **[Zen](https://zen-browser.app)** | Same minimal philosophy as Arc, open source |
| **[Edge](https://microsoft.com/edge)** | Enable vertical tab bar to collapse the top area to a single line |
| **[Chrome](https://google.com/chrome)** | Enable vertical tab bar to collapse the top area to a single line |

### Productivity Suite

#### Google Workspace

Google was the first to push the browser-first model seriously. All web-native from the start, still the gold standard for real-time collaboration.

- [Gmail](https://mail.google.com)
- [Docs](https://docs.google.com)
- [Sheets](https://sheets.google.com)
- [Slides](https://slides.google.com)
- [Drive](https://drive.google.com)
- [Meet](https://meet.google.com)
- [Calendar](https://calendar.google.com)

If you're starting fresh or don't have org constraints, Google Workspace is the easiest path. Everything syncs, everything works offline, and sharing is built in.

#### Microsoft 365

Office Online has caught up. Word, Excel, PowerPoint in the browser are now good enough for most tasks. If your org is on M365, lean into it — everything works in the browser.

- [Outlook](https://outlook.live.com)
- [Word](https://word.office.com)
- [Excel](https://excel.office.com)
- [PowerPoint](https://powerpoint.office.com)
- [OneDrive](https://onedrive.live.com)
- [Teams](https://teams.microsoft.com)

### Password Manager

**[KeeWeb](https://keeweb.info)** — KeePass-compatible, open source, works as an offline web app with no install. Syncs your `.kdbx` file via Dropbox, Google Drive, OneDrive, or your own server. Desktop apps available too if you want them.

### IDE

VS Code has three browser modes — they're different products, often confused:

**[VS Code `serve-web`](https://code.visualstudio.com/docs/remote/vscode-server)** — Run `code serve-web` on your machine, open the URL in any browser on your network. Fully self-hosted, no Microsoft infrastructure involved. Full VS Code with terminal, extensions, and debugger. Best for local network access from a tablet or secondary device.

**[code-server](https://github.com/coder/code-server)** — Open source, self-hosted VS Code server by Coder. Same idea as `serve-web` but community-driven, more deployment options, and multi-user capable. Total control over your setup.

**[vscode.dev](https://vscode.dev)** — Runs entirely in your browser, no server needed. Zero setup, works on any device. Opens GitHub repos directly (`vscode.dev/github/<org>/<repo>`). No terminal, no debugger, and many extensions don't work because there's no backend to run them on.

| | `serve-web` | code-server | vscode.dev |
|--|-------------|-------------|------------|
| Terminal | ✅ | ✅ | ❌ |
| Self-hosted | ✅ | ✅ | ❌ |
| Extensions | ✅ full | ✅ full | ⚠️ limited |
| Setup | Easy | Medium | None |
| Best for | Local network | Self-hosted teams | Quick browsing |

### Terminal

Three approaches to a browser terminal:

| Tool | Sessions | Multi-tab | Windows | Notes |
|------|----------|-----------|---------|-------|
| **webtty** | ✅ | ✅ | ✅ | Lightweight, session-aware, cross-platform |
| **ttyd** | ❌ | ❌ | ✅ | Simple, one shell per URL; session terminates when WebSocket connection is lost |
| **Zellij** (web mode) | ✅ | ✅ | ❌ | Full multiplexer with web mode support, but Linux/macOS only |

ttyd is fine if you just need a quick shell in the browser. Zellij web mode is powerful but doesn't run on Windows. webtty is the middle ground — sessions, reconnect, multiple terminals, works everywhere.

### Terminal Software Recommendations

What to run inside your browser terminal. These are the tools that make terminal work actually pleasant:

**Shell**
- **fish** — sensible defaults, autosuggestions, no config required to be useful

**Editor**
- **NvChad** (Neovim) — full IDE feel in the terminal, built-in LSP and syntax highlighting

**File Manager**
- **yazi** — fast, terminal file manager with preview

**Git**
- **gitui** — terminal UI for git, better than memorizing flags

**Multiplexer / Layout**
- **Zellij** — terminal workspace with layouts; pairs well with webtty for managing multiple sessions

**Prompt**
- **starship** — fast, minimal, works with any shell

**AI**
- **OpenCode** — open-source AI coding agent in the terminal
- **Claude Code** — Anthropic's CLI coding assistant

---

The browser is no longer a limitation. It's where the best tools live now.
