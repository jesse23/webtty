# Awesome Web

A personal guide to living in the browser.

## Why the Browser

The browser is where you already spend your time. One window, sync across devices, no install friction. The web platform caught up — most apps you need run well in it now.

**The principle**: if a web version exists and it's good enough, use it. Not because native is bad, but because staying in the browser means fewer windows, fewer context switches, and a setup that works the same everywhere — your main machine, a work laptop, a tablet, or a borrowed computer.

You don't need a native app for everything.

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

### Password Manager

**[KeeWeb](https://keeweb.info)** — KeePass-compatible, open source, works as an offline web app with no install. Syncs your `.kdbx` file via Dropbox, Google Drive, OneDrive, or your own server. Desktop apps available too if you want them.

### Productivity Suite

#### Google Workspace

Google was the first to push the browser-first model seriously. All web-native from the start, still the gold standard for real-time collaboration.

- [Gmail](https://mail.google.com)
- [Drive](https://drive.google.com)
- [Sheets](https://sheets.google.com)
- [Docs](https://docs.google.com)
- [Slides](https://slides.google.com)
- [Meet](https://meet.google.com)
- [Calendar](https://calendar.google.com)

If you're starting fresh or don't have org constraints, Google Workspace is the easiest path. Everything syncs, everything works offline, and sharing is built in.

#### Microsoft 365

Office Online has caught up. Word, Excel, PowerPoint in the browser are now good enough for most tasks. If your org is on M365, lean into it — everything works in the browser.

- [Outlook](https://outlook.live.com)
- [Teams](https://teams.microsoft.com)
- [OneDrive](https://onedrive.live.com)
- [Word](https://word.office.com)
- [Excel](https://excel.office.com)
- [PowerPoint](https://powerpoint.office.com)

#### AI Assistants

The major AI assistants all live in the browser — no install needed.

- [M365 Copilot](https://microsoft365.com/copilot)
- [Claude](https://claude.ai) 
- [ChatGPT](https://chatgpt.com)
- [Gemini](https://gemini.google.com)
- [Grok](https://grok.com)

### IDE

VS Code has three browser modes — they're different products, often confused:

**[VS Code `serve-web`](https://code.visualstudio.com/docs/remote/vscode-server)** — Run `code serve-web` on your machine, open the URL in any browser. Fully self-hosted, no Microsoft infrastructure. Full VS Code with terminal, extensions, and debugger — the browser-first way to run your editor.

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

Great native terminals exist — [Ghostty](https://ghostty.org), [Alacritty](https://alacritty.org), [WezTerm](https://wezfurlong.org/wezterm), [Windows Terminal](https://aka.ms/terminal) — but a browser terminal keeps you in one window, makes sessions just URLs, and removes the context switch between editor and terminal. On Windows especially, the native multiplexer story is weak — no tmux, limited Zellij support — and the browser fills that gap naturally.

Here's every known approach and how they compare:

| Tool | Sessions | Windows | Notes |
|------|----------|---------|-------|
| **[webtty](https://github.com/jesse23/webtty)** (current repo) | ✅ | ✅ | Lightweight, session-aware, cross-platform |
| **[VibeTunnel](https://github.com/amantus-ai/vibetunnel)** | ✅ | ❌ | macOS/Linux, built for AI agent monitoring, native menu bar app + `vt` command wrapper |
| **[ttyd](https://github.com/tsl0922/ttyd)** | ❌ | ✅ | One shell per URL; session terminates when the connection drops |
| **[GoTTY](https://github.com/yudai/gotty)** | ❌ | ❌ | Lightweight Go tool, abandoned since 2017 |
| **[Zellij](https://zellij.dev)** (web mode) | ✅ | ❌ | Full multiplexer with web mode, Linux/macOS only |

### Terminal Software Recommendations

Good pieces for a solid terminal workflow:

| Name | Type | Description |
|------|------|-------------|
| **[fish](https://fishshell.com)** | Shell | Sensible defaults, autosuggestions, no config required to be useful |
| **[starship](https://starship.rs)** | Shell | Fast, minimal shell prompt, works with any shell |
| **[Clink](https://chrisant996.github.io/clink)** | Shell (Windows) | Powerful Bash-style line editing and completions for Windows cmd.exe |
| **[MSYS2](https://www.msys2.org)** | Shell (Windows) | Unix-like shell environment on Windows with pacman package manager |
| **[Zellij](https://zellij.dev)** | Multiplexer | Terminal workspace with layouts; pairs well with webtty for multiple sessions |
| **[NvChad](https://nvchad.com)** (Neovim) | Editor | Full IDE feel in the terminal, built-in LSP and syntax highlighting. Note: has unresolved lagging issues |
| **[vim](https://www.vim.org)** | Editor | Self-customized vim is more efficient for vibe coding — no framework overhead |
| **[yazi](https://yazi-rs.github.io)** | File Manager | Fast terminal file manager with preview |
| **[gitui](https://github.com/extrawurst/gitui)** | Git | Terminal UI for git, better than memorizing flags |
| **[lazygit](https://github.com/jesseduffield/lazygit)** | Git | Alternative git TUI, more opinionated workflow |
| **[delta](https://github.com/dandavison/delta)** | Git | Syntax-highlighting pager for git diffs — configure as `core.pager` in gitconfig |
| **[fzf](https://github.com/junegunn/fzf)** | Search | Fuzzy finder for files, history, and anything else piped to it |
| **[fd](https://github.com/sharkdp/fd)** | Search | Fast, user-friendly alternative to `find` |
| **[ripgrep](https://github.com/BurntSushi/ripgrep)** | Search | Blazing fast grep — respects `.gitignore` by default |
| **[eza](https://eza.rocks)** | Utility | Modern `ls` replacement with icons, git status, and tree view |
| **[bottom](https://github.com/ClementTsang/bottom)** | Utility | Cross-platform system monitor with a TUI |
| **[glow](https://github.com/charmbracelet/glow)** | Utility | Render markdown in the terminal with style |
| **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** | Utility | Download video/audio from YouTube and hundreds of other sites |

### Agentic CLI

CLI tools that go beyond code completion — they plan, execute commands, manage files, search the web, and work through multi-step tasks autonomously in your terminal.

| Name | Subscription | Description |
|------|-------------|-------------|
| **[OpenCode](https://github.com/sst/opencode)** | GitHub Copilot | Open-source terminal AI agent, provider-agnostic |
| **[Claude Code](https://docs.anthropic.com/claude-code)** | Claude Pro ($20/mo) or Max ($100/$200/mo) | Anthropic's terminal agent — strong at reasoning and long multi-step tasks |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot)** | Free ($0) / Pro ($10/mo) / Pro+ ($39/mo) | GitHub-native terminal agent with `/plan`, `/fleet` for parallel execution |
| **[Gemini CLI](https://github.com/google-gemini/gemini-cli)** | Free (1k req/day) / Google One AI Premium | Google's open-source terminal agent, generous free tier, 1M token context |
| **[Codex CLI](https://github.com/openai/codex)** | ChatGPT Plus/Pro/Team | OpenAI's terminal agent, lightweight, runs locally |

---

The browser is no longer a limitation. It's where the best tools live now.
