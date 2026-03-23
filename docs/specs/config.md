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
  "port": 2346,                 // HTTP listen port; env PORT takes precedence

  // Shell
  "shell": "/bin/zsh",          // shell for new sessions; default: $SHELL on Unix, %COMSPEC% on Windows

  // Terminal
  "cols": 80,                   // initial terminal width in columns
  "rows": 24,                   // initial terminal height in rows
  "scrollback": 262144,         // PTY history buffer in bytes (256 KB); used for server-side replay on reload/reconnect
  "cursorBlink": true,          // whether the cursor blinks
  "fontSize": 14,               // font size in px
  "fontFamily": "'FiraMono Nerd Font', Menlo, Monaco, 'Courier New', monospace",  // CSS font-family stack

  // Theme — Dracula by default; any hex color values accepted
  "theme": {
    "background":   "#282A36",
    "foreground":   "#F8F8F2",
    // ... all 16 ANSI colors + cursor + selection
  }
}
```

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Config lifecycle | First-run write + subsequent load, as described above | — | ⬜ |
