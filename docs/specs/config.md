# SPEC: Config

**Author:** jesse23
**Last Updated:** 2026-03-23

---

## Description

webtty reads configuration from `~/.config/webtty/config.json`. The file is the single source of truth for persistent user preferences. Environment variables override config file values at runtime but never modify the file.

## File location

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.config/webtty/config.json` |
| Windows | `%USERPROFILE%\.config\webtty\config.json` |

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
   │
   ▼
valid JSON? ────────────────────────────┐
   │                                    │
  yes                                   no
   │                                    │
   ▼                                    ▼
merge with defaults                error: print
(unknown keys ignored)             path, exit
   │
   ▼
apply env overrides
(PORT > config.port, etc.)
   │
   ▼
config ready
```

- **First run**: defaults are written to disk so the user has a file to edit.
- **Subsequent runs**: file is read and merged with defaults — missing keys fall back to defaults, so adding new config keys in future versions is non-breaking.
- **Invalid JSON**: hard error with a clear message pointing to the file path. webtty does not attempt to repair or overwrite a corrupt file.
- **Unknown keys**: silently ignored (forward-compatibility — a config written by a newer version works with an older binary).
- **Env overrides**: applied after the file is loaded, never written back to the file.

## Schema

```jsonc
{
  // Server
  "port": 2346,

  // Shell
  "shell": "/bin/zsh",        // default: $SHELL on Unix, %COMSPEC% on Windows

  // Terminal
  "cols": 80,
  "rows": 24,
  "scrollback": 10000,        // lines in the terminal UI display buffer
  "scrollbackBuffer": 262144, // server-side PTY replay buffer in bytes (256 KB default)
  "cursorBlink": true,
  "fontSize": 14,
  "fontFamily": "'FiraMono Nerd Font', Menlo, Monaco, 'Courier New', monospace",

  // Theme (Dracula defaults)
  "theme": {
    "background":   "#282A36",
    "foreground":   "#F8F8F2",
    "cursor":       "#F8F8F2",
    "selection":    "#44475A",
    "black":        "#21222C",
    "red":          "#FF5555",
    "green":        "#50FA7B",
    "yellow":       "#F1FA8C",
    "blue":         "#BD93F9",
    "purple":       "#FF79C6",
    "cyan":         "#8BE9FD",
    "white":        "#F8F8F2",
    "brightBlack":  "#6272A4",
    "brightRed":    "#FF6E6E",
    "brightGreen":  "#69FF94",
    "brightYellow": "#FFFFA5",
    "brightBlue":   "#D6ACFF",
    "brightPurple": "#FF92DF",
    "brightCyan":   "#A4FFFF",
    "brightWhite":  "#FFFFFF"
  }
}
```

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Config lifecycle | First-run write + subsequent load, as described above | — | ⬜ |
