# SPEC: Config

**Author:** jesse23
**Last Updated:** 2026-03-23

---

## Description

webtty reads configuration from `~/.config/webtty/config.jsonc`. The file supports comments (JSONC format via `strip-json-comments`). It is the single source of truth for persistent user preferences. Environment variables override config file values at runtime but never modify the file.

## File location

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.config/webtty/config.jsonc` |
| Windows | `%USERPROFILE%\.config\webtty\config.jsonc` |

## Lifecycle

```
webtty server starts
   │
   ▼
config file exists? ────────────────────┐
   │                                    │
  yes                                   no
   │                                    │
   ▼                                    ▼
read + parse JSON ◄──────── write defaults to file
   │                              │ write fails?
   ▼                              ▼
valid JSON? ──────── no ──► warn + use defaults in memory
   │
   ▼
merge with defaults
(unknown keys ignored)
   │
   ▼
apply env overrides
(PORT > config.port, etc.)
   │
   ▼
config ready (port/host locked for server lifetime)
```

```
browser tab reloads  (GET /s/:id)
   │
   ▼
loadConfig() — re-read file from disk
   │
   ▼
render HTML with fresh appearance settings
(cols, rows, fontSize, fontFamily, cursorBlink, scrollback, theme)
```

- **First run**: defaults are written to disk so the user has a file to edit.
- **Subsequent runs**: file is read and merged with defaults — missing keys fall back to defaults, so adding new config keys in future versions is non-breaking.
- **Write failure on first run**: warns to stderr, continues with in-memory defaults (no crash).
- **Invalid JSON**: hard error with a clear message pointing to the file path. webtty does not attempt to repair or overwrite a corrupt file.
- **Unknown keys**: silently ignored (forward-compatibility — a config written by a newer version works with an older binary).
- **Env overrides**: applied after the file is loaded, never written back to the file.
- **Hot config reload**: `port` and `host` are locked for the server lifetime (changing them requires a restart). All appearance settings (`cols`, `rows`, `fontSize`, `fontFamily`, `cursorBlink`, `scrollback`, `theme`) and `shell`/`term` for *new* sessions take effect on the next browser tab reload — no server restart needed.

## Schema

```jsonc
{
  // Server
  // HTTP listen port; env PORT takes precedence
  "port": 2346,
  // Bind address; use "0.0.0.0" for remote access
  "host": "127.0.0.1",

  // Shell
  // Shell for new sessions; defaults to $SHELL / %COMSPEC% if omitted
  // "shell": "/bin/zsh",
  // $TERM env var passed to the shell
  // "term": "xterm-256color",

  // Terminal
  // PTY history buffer in bytes (256 KB); used for server-side replay on reload/reconnect
  // "scrollback": 262144,
  // Initial terminal width in columns
  // "cols": 80,
  // Initial terminal height in rows
  // "rows": 24,
  // Whether the cursor blinks
  // "cursorBlink": true,
  // Font size in px
  // "fontSize": 14,
  // CSS font-family stack
  // "fontFamily": "'FiraMono Nerd Font', Menlo, Monaco, 'Courier New', monospace",

  // Theme — terminal color palette, Dracula by default
  // "theme": {
  //   "background":   "#282A36",  // terminal background
  //   "foreground":   "#F8F8F2",  // default text color
  //   "cursor":       "#F8F8F2",  // cursor color
  //   "selection":    "#44475A",  // selection highlight
  //   "black":        "#21222C",  // ANSI 0
  //   "red":          "#FF5555",  // ANSI 1
  //   "green":        "#50FA7B",  // ANSI 2
  //   "yellow":       "#F1FA8C",  // ANSI 3
  //   "blue":         "#BD93F9",  // ANSI 4
  //   "purple":       "#FF79C6",  // ANSI 5
  //   "cyan":         "#8BE9FD",  // ANSI 6
  //   "white":        "#F8F8F2",  // ANSI 7
  //   "brightBlack":  "#6272A4",  // ANSI 8
  //   "brightRed":    "#FF6E6E",  // ANSI 9
  //   "brightGreen":  "#69FF94",  // ANSI 10
  //   "brightYellow": "#FFFFA5",  // ANSI 11
  //   "brightBlue":   "#D6ACFF",  // ANSI 12
  //   "brightPurple": "#FF92DF",  // ANSI 13
  //   "brightCyan":   "#A4FFFF",  // ANSI 14
  //   "brightWhite":  "#FFFFFF"   // ANSI 15
  // }
}
```

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Config lifecycle | First-run write + subsequent load, merge with defaults, env overrides | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| `port` / `host` | Override HTTP listen port and bind address | [ADR 008](../adrs/008.webtty.config.md) | ⬜ |
| `shell` / `term` | Override shell and `$TERM` env var for new sessions | [ADR 008](../adrs/008.webtty.config.md) | ⬜ |
| `scrollback` | PTY history buffer size in bytes | [ADR 008](../adrs/008.webtty.config.md) | ⬜ |
| Terminal appearance | `cols`, `rows`, `fontSize`, `fontFamily`, `cursorBlink` injected into client HTML | [ADR 008](../adrs/008.webtty.config.md) | ⬜ |
| `theme` | Terminal color palette injected into client HTML | [ADR 008](../adrs/008.webtty.config.md) | ⬜ |
| Hot config reload | Appearance settings re-read from disk on every tab reload; `port`/`host` locked for server lifetime | [ADR 009](../adrs/009.webtty.config-hot-reload.md) | ⬜ |
