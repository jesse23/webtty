# SPEC: Config

**Author:** jesse23
**Last Updated:** 2026-03-23

---

## Description

webtty reads configuration from `~/.config/webtty/config.json`. It is the single source of truth for persistent user preferences. Environment variables override config file values at runtime but never modify the file.

## File location

| Platform | Path |
|----------|------|
| macOS / Linux | `~/.config/webtty/config.json` |
| Windows | `%USERPROFILE%\.config\webtty\config.json` |

## Lifecycle

### Server startup

```
webtty server starts
   │
   ▼
config file exists? ────────────────────┐
   │                                    │
  yes                                   no
   │                                    │
   ▼                                    ▼
read + parse JSON               write defaults to file
   │                                    │
   │                              write fails?
   │                                    │
   │                            warn to stderr +
   │                            use defaults in memory ──► port/host locked
   ▼
valid JSON?
   │
  no ──► hard error: print path, exit
   │
  yes
   ▼
merge with defaults
(unknown keys ignored)
   │
   ▼
apply env overrides
(PORT > config.port, etc.)
   │
   ▼
port/host locked for server lifetime
```

### Browser tab load / reload  (`GET /s/:id`)

```
browser requests /s/:id
   │
   ▼
loadConfig() — re-read file from disk
   │
   ▼
render HTML with fresh appearance settings injected:
cols, rows, fontSize, fontFamily, cursorBlink, scrollback, theme
```

### New PTY spawn  (first WebSocket connection to a session)

```
WebSocket connects to /ws/:id
   │
   ▼
session has no running PTY?
   │
  yes
   ▼
loadConfig() — re-read file from disk
   │
   ▼
spawn PTY with fresh: shell, term, colorTerm, scrollback
```

### Rules

- **First run**: defaults are written to disk so the user has a file to edit.
- **Subsequent runs**: file is read and merged with defaults — missing keys fall back to defaults, so adding new config keys in future versions is non-breaking.
- **Write failure on first run**: warns to stderr, continues with in-memory defaults (no crash).
- **Invalid JSON**: hard error with a clear message pointing to the file path. webtty does not attempt to repair or overwrite a corrupt file.
- **Unknown keys**: silently ignored (forward-compatibility — a config written by a newer version works with an older binary).
- **Env overrides**: `PORT` overrides `config.port` at runtime. Applied after file load, never written back.
- **Hot config reload**:
  - `port` / `host` — locked at startup (server socket already bound; restart required).
  - `cols`, `rows`, `fontSize`, `fontFamily`, `cursorBlink`, `scrollback`, `theme` — re-read on every tab reload.
  - `shell`, `term`, `colorTerm`, `scrollback` — re-read when a new PTY is spawned (i.e. first connection to a session that has no running shell).
  - An already-running session is never affected mid-flight.

## Schema

All keys are optional — omit any key to use the default value.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `2346` | HTTP listen port; env `PORT` takes precedence |
| `host` | string | `"127.0.0.1"` | Bind address; use `"0.0.0.0"` for remote access |
| `shell` | string | `$SHELL` / `%COMSPEC%` | Shell for new sessions |
| `term` | string | `$TERM` | `$TERM` env var passed to the shell |
| `colorTerm` | string | `"truecolor"` | `$COLORTERM` env var passed to the shell |
| `scrollback` | number | `262144` | PTY history buffer in bytes; used for server-side replay on reload/reconnect |
| `cols` | number | `80` | Initial terminal width in columns |
| `rows` | number | `24` | Initial terminal height in rows |
| `cursorBlink` | boolean | `true` | Whether the cursor blinks |
| `copyOnSelect` | boolean | `true` | Auto-copy selection to clipboard on mouseup (kitty / Windows Terminal style) |
| `rightClickBehavior` | string | `"copyPaste"` | Right-click behavior: `"copyPaste"` copies selection + clears it if selection exists, otherwise native menu; `"default"` always shows native context menu |
| `fontSize` | number | `13` | Font size in px |
| `fontFamily` | string | `"Menlo, Consolas, 'DejaVu Sans Mono', monospace"` | CSS font-family stack |
| `theme` | object | Campbell | Terminal color palette — see theme keys below |

### Theme keys

All theme keys are optional; omitted keys fall back to the Campbell (Windows Terminal default) palette.

| Key | Default | Description |
|-----|---------|-------------|
| `background` | `#000000` | Terminal background |
| `foreground` | `#CCCCCC` | Default text color |
| `cursor` | `#FFFFFF` | Cursor color |
| `selection` | `#FFFFFF` | Selection highlight |
| `black` | `#0C0C0C` | ANSI 0 |
| `red` | `#C50F1F` | ANSI 1 |
| `green` | `#13A10E` | ANSI 2 |
| `yellow` | `#C19C00` | ANSI 3 |
| `blue` | `#0037DA` | ANSI 4 |
| `purple` | `#881798` | ANSI 5 |
| `cyan` | `#3A96DD` | ANSI 6 |
| `white` | `#CCCCCC` | ANSI 7 |
| `brightBlack` | `#767676` | ANSI 8 |
| `brightRed` | `#E74856` | ANSI 9 |
| `brightGreen` | `#16C60C` | ANSI 10 |
| `brightYellow` | `#F9F1A5` | ANSI 11 |
| `brightBlue` | `#3B78FF` | ANSI 12 |
| `brightPurple` | `#B4009E` | ANSI 13 |
| `brightCyan` | `#61D6D6` | ANSI 14 |
| `brightWhite` | `#F2F2F2` | ANSI 15 |

### Example

```json
{
  "port": 2346,
  "host": "127.0.0.1",

  "shell": "/bin/zsh",
  "term": "xterm-256color",

  "scrollback": 262144,
  "cols": 80,
  "rows": 24,
  "cursorBlink": true,
  "fontSize": 13,
  "fontFamily": "Menlo, Consolas, 'DejaVu Sans Mono', monospace",

  "theme": {
    "background":   "#000000",
    "foreground":   "#CCCCCC",
    "cursor":       "#FFFFFF",
    "selection":    "#FFFFFF",
    "black":        "#0C0C0C",
    "red":          "#C50F1F",
    "green":        "#13A10E",
    "yellow":       "#C19C00",
    "blue":         "#0037DA",
    "purple":       "#881798",
    "cyan":         "#3A96DD",
    "white":        "#CCCCCC",
    "brightBlack":  "#767676",
    "brightRed":    "#E74856",
    "brightGreen":  "#16C60C",
    "brightYellow": "#F9F1A5",
    "brightBlue":   "#3B78FF",
    "brightPurple": "#B4009E",
    "brightCyan":   "#61D6D6",
    "brightWhite":  "#F2F2F2"
  }
}
```

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Config lifecycle | First-run write + subsequent load, merge with defaults, env overrides | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| `port` / `host` | Override HTTP listen port and bind address | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| `shell` / `term` / `colorTerm` | Override shell and `$TERM` / `$COLORTERM` env vars for new PTY sessions | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| `scrollback` | PTY history buffer size in bytes; shared between server-side replay and client-side line buffer | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Terminal appearance | `cols`, `rows`, `fontSize`, `fontFamily`, `cursorBlink` injected into client HTML | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| `theme` | Terminal color palette injected into client HTML | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Hot config reload | Appearance re-read on tab reload; shell/PTY settings re-read on new PTY spawn; `port`/`host` locked for server lifetime | [ADR 009](../adrs/009.webtty.config-hot-reload.md) | ✅ |
