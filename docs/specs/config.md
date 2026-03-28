# SPEC: Config

**Author:** jesse23
**Last Updated:** 2026-03-27

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
cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollback, theme
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
  - `cols`, `rows`, `fontSize`, `fontFamily`, `cursorStyle`, `cursorStyleBlink`, `scrollback`, `theme`, `copyOnSelect`, `rightClickBehavior`, `mouseScrollSpeed`, `keyboardBindings` — re-read on every tab reload. `cursorStyle` and `cursorStyleBlink` set the startup defaults; apps override them at runtime via DECSCUSR.
  - `shell`, `term`, `colorTerm`, `scrollback` — re-read when a new PTY is spawned (i.e. first connection to a session that has no running shell).
  - An already-running session is never affected mid-flight.
  - Historical note: ADR 008/009/012 describe an earlier config flow that used a `cursorBlink` key and different HTML injection mechanics. Those ADRs are considered historical; this spec's `cursorStyle` / `cursorStyleBlink` behavior is authoritative.

## Schema

All keys are optional — omit any key to use the default value.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `port` | number | `2346` | HTTP listen port; env `PORT` takes precedence |
| `host` | string | `"127.0.0.1"` | Bind address; use `"0.0.0.0"` for remote access |
| `shell` | string | `$SHELL` / `%COMSPEC%` | Shell for new sessions |
| `term` | string | `"xterm-256color"` | `$TERM` env var passed to the shell. Fixed to `xterm-256color` — the PTY child talks to webtty, not to the parent terminal. See [ADR 016](../adrs/016.config.term-default.md). |
| `colorTerm` | string | `"truecolor"` | `$COLORTERM` env var passed to the shell |
| `scrollback` | number | `262144` | PTY history buffer in bytes; used for server-side replay on reload/reconnect |
| `cols` | number | `80` | Initial terminal width in columns |
| `rows` | number | `24` | Initial terminal height in rows |
| `cursorStyle` | string | `"bar"` | Default cursor shape: `"bar"` (vertical line), `"block"`, or `"underline"`. Apps override at runtime via DECSCUSR — this is the startup default only. |
| `cursorStyleBlink` | boolean | `true` | Default blink state. Apps override at runtime via DECSCUSR — this is the startup default only. |
| `copyOnSelect` | boolean | `true` | Auto-copy selection to clipboard on mouseup (kitty / Windows Terminal style) |
| `rightClickBehavior` | string | `"default"` | Right-click behavior: `"copyPaste"` copies selection + clears it if selection exists, otherwise native menu; `"default"` always shows native context menu. Invalid values fall back to `"default"` |
| `mouseScrollSpeed` | number | `1` | Mouse wheel scroll speed multiplier for apps with mouse tracking (e.g. vim `set mouse=a`). `1` = one SGR event per wheel tick (default). Values `< 1` reduce rate (e.g. `0.5` fires every other tick); values `> 1` send multiple SGRs per tick. Must be `> 0`. |
| `logs` | boolean | `false` | Write server stdout/stderr to `~/.config/webtty/server.log`. Appends on each start. Default `false` — server runs silently. |
| `fontSize` | number | `13` | Font size in px |
| `fontFamily` | string | `"Menlo, Consolas, 'DejaVu Sans Mono', monospace"` | CSS font-family stack |
| `theme` | object | Campbell | Terminal color palette — see theme keys below |
| `keyboardBindings` | array | see below | Custom key-to-sequence bindings sent to the PTY. Merged with defaults by `key`+`mods` identity — see keyboard bindings below. |

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

### Keyboard binding objects

Each entry in `keyboardBindings` is an object with the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Key name, matched case-insensitively against `KeyboardEvent.key`. Special keys: `"enter"`, `"escape"`, `"tab"`, `"backspace"`, `"delete"`, `"space"`, `"arrowup"`, `"arrowdown"`, `"arrowleft"`, `"arrowright"`, `"f1"`–`"f12"`. Printable characters: `"a"`–`"z"`, `"0"`–`"9"`, etc. |
| `mods` | string[] | no | Array of modifier names. Accepted values: `"shift"`, `"ctrl"`, `"alt"`, `"meta"`. Examples: `["shift"]`, `["ctrl", "shift"]`. Omit or `[]` for no modifiers. Order does not matter — `["ctrl", "shift"]` and `["shift", "ctrl"]` are equivalent. Unknown values are silently ignored. |
| `chars` | string | yes | Escape sequence sent verbatim to the PTY. Must be a valid JSON string — use `\uXXXX` for non-printable bytes (e.g. `"\u001b"` for ESC). `\x` hex notation is **not valid JSON** and will cause a parse error. Standard escapes `\r`, `\n`, `\t` work as expected. All escapes are resolved by `JSON.parse` at config load; the string is sent as-is with no further processing. |

#### How to define `chars`

The `chars` value is the byte sequence your TUI app expects to receive for that key combo.

Take `"\u001b[13;2u"` as an example — the kitty keyboard protocol sequence for Shift+Enter, used by opencode, Helix, and most modern TUI apps. Most TUI apps follow one of two conventions:

| Convention | Shift+Enter | Used by |
|---|---|---|
| [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) | `"\u001b[13;2u"` | Helix, opencode, modern TUI apps |
| Legacy ESC CR | `"\u001b\r"` | older TUI apps |

**Legacy convention** — the sequence is app-specific. Check the binding examples below, or search the app's source for `\x1b\r` near its input handling code.

**Kitty keyboard protocol** — sequences are standardized and can be derived from a formula:

```
\u001b [ {keycode} ; {modifier} u
```

Modifier value = `1` + sum of active modifiers (Shift `1`, Alt `2`, Ctrl `4`, Meta `8`):

| Modifiers | Modifier value | Shift+Enter example |
|---|---|---|
| Shift | 1+1 = 2 | `"\u001b[13;2u"` |
| Alt | 1+2 = 3 | `"\u001b[13;3u"` |
| Ctrl | 1+4 = 5 | `"\u001b[13;5u"` |
| Shift+Ctrl | 1+1+4 = 6 | `"\u001b[13;6u"` |

Common keycodes for the formula:

| Key | Keycode | Shift example |
|---|---|---|
| Enter | 13 | `"\u001b[13;2u"` |
| Tab | 9 | `"\u001b[9;2u"` |
| Backspace | 127 | `"\u001b[127;2u"` |
| Escape | 27 | `"\u001b[27;2u"` |
| Space | 32 | `"\u001b[32;2u"` |

Full keycode table: [kitty keyboard protocol — functional key definitions](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions).

#### Binding examples

| Intent | `key` | `mods` | `chars` |
|---|---|---|---|
| Shift+Enter → new line (opencode, Helix, etc.) | `"enter"` | `["shift"]` | `"\u001b[13;2u"` |
| Ctrl+Enter → same | `"enter"` | `["ctrl"]` | `"\u001b[13;5u"` |
| Shift+Tab → backtab | `"tab"` | `["shift"]` | `"\u001b[9;2u"` |
| Suppress a key (consume without sending) | `"enter"` | `["shift"]` | `""` |

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
  "cursorStyle": "bar",
  "cursorStyleBlink": true,
  "copyOnSelect": true,
  "rightClickBehavior": "default",
  "fontSize": 13,
  "fontFamily": "Menlo, Consolas, 'DejaVu Sans Mono', monospace",

  "keyboardBindings": [
    { "key": "enter", "mods": ["shift"], "chars": "\u001b[13;2u" },
    { "key": "enter", "mods": ["ctrl"],  "chars": "\u001b[13;5u" }
  ],

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
| Config lifecycle | First-run write, merge with defaults, env overrides, hot-reload on tab reload | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Server settings | `port`, `host` — locked at startup; `shell`, `term`, `colorTerm` — applied per new PTY. `term` defaults to `xterm-256color` (not inherited from parent process) | [ADR 008](../adrs/008.webtty.config.md), [ADR 016](../adrs/016.config.term-default.md) | ✅ |
| Terminal appearance | `cols`, `rows`, `fontSize`, `fontFamily`, `cursorStyle`, `cursorStyleBlink`, `scrollback`, `theme` — re-read on tab reload | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Hot config reload | Appearance re-read on tab reload; shell/PTY settings re-read on new PTY spawn; `port`/`host` locked for server lifetime | [ADR 009](../adrs/009.webtty.config-hot-reload.md) | ✅ |
| Copy behavior | `copyOnSelect` + `rightClickBehavior` — configurable clipboard copy matching VS Code / kitty conventions | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Server logs | `logs: true` appends server stdout/stderr to `~/.config/webtty/server.log` | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Cursor style | `cursorStyle` sets the default cursor shape; DECSCUSR sequences from apps override at runtime | [ADR 013](../adrs/013.client.cursor-style.md) | ✅ |
| Mouse scroll speed | `mouseScrollSpeed` scales SGR events per wheel tick for apps with mouse tracking; default `1` | [ADR 017](../adrs/017.client.mouse-scroll.md) | ✅ |
| Keyboard bindings | `keyboardBindings` — configurable key-to-sequence mappings sent to PTY; defaults to `[]`, users add entries in `~/.config/webtty/config.json` | [ADR 018](../adrs/018.client.keyboard-bindings.md) | ✅ |
