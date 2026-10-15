# SPEC: Config

**Last Updated:** 2026-10-15

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
cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollback, scrollbackLines, theme
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
  - `cols`, `rows`, `fontSize`, `fontFamily`, `cursorStyle`, `cursorStyleBlink`, `scrollback`, `scrollbackLines`, `theme`, `copyOnSelect`, `rightClickBehavior`, `clipboardWrite`, `bellTitle`, `desktopNotifications`, `mouseScrollSpeed`, `padding`, `keyboardBindings` — re-read on every tab reload. `cursorStyle` and `cursorStyleBlink` set the terminal's default cursor; apps override it at runtime via DECSCUSR (mode 12 is ignored, as in Ghostty with `cursor-style-blink` set), and DECSCUSR 0 or a reset restores it.
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
| `scrollback` | number | `262144` | PTY history buffer in bytes; used for server-side replay on reload/reconnect. It does not set the terminal's history; that is `scrollbackLines` |
| `scrollbackLines` | number | `10000` | Terminal history in lines; `0` = no line limit. History is also capped at 32 MiB, so wide terminals with many styles can keep fewer lines, and Ghostty prunes whole pages, so it keeps a little under the limit (about 9,700 of 10,000). Fractions are floored; negative values are ignored. The client derives nothing from `scrollback`. See [ADR 046](../adrs/046.client.scrollback-lines.md) and [ADR 047](../adrs/047.client.official-engine-only.md). |
| `cols` | number | `80` | Initial terminal width in columns |
| `rows` | number | `24` | Initial terminal height in rows |
| `cursorStyle` | string | `"bar"` | Default cursor shape: `"bar"` (vertical line), `"block"`, or `"underline"`. Apps override at runtime via DECSCUSR; `CSI 0 SP q` and a terminal reset restore it. |
| `cursorStyleBlink` | boolean | `true` | Default blink state. Apps override at runtime via DECSCUSR; `CSI 0 SP q` and a terminal reset restore it. DEC mode 12 (`CSI ? 12 h/l`) is ignored, as in Ghostty when `cursor-style-blink` is set, so an app that turns blinking off that way (vim's `t_ve`) does not leave the cursor steady. |
| `copyOnSelect` | boolean | `true` | Copy a mouse selection (drag, double or triple click) to the clipboard when the button is released, then clear the highlight, as herdr does (Claude Code and pi in fullscreen keep theirs); off, the selection stays to copy with Cmd+C, Ctrl+Shift+C or the menu. While the app tracks the mouse (vim `set mouse=a`, htop, Claude Code fullscreen), a drag goes to the app and is not a selection, so nothing is copied; hold Shift to select and copy in webtty instead. See [ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md). |
| `rightClickBehavior` | string | `"contextMenu"` | What a right-click does when the app does not take it: `"contextMenu"` shows the browser menu; `"copyPaste"` copies and clears an existing selection, otherwise shows the menu; `"paste"` pastes the clipboard as Ctrl+V does; `"none"` does nothing and shows no menu. While the app tracks the mouse, a right-click goes only to the app and no menu is shown; Shift+right-click applies this setting instead and sends nothing to the app. `"default"`, the old name of `"contextMenu"`, is still accepted; invalid values fall back to `"contextMenu"`. Windows Terminal users may prefer `"copyPaste"`. See [ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md). |
| `clipboardWrite` | boolean | `true` | Let programs write the clipboard with OSC 52 (`ESC ] 52 ; c ; <base64> BEL`), as Claude Code, pi, Neovim 0.10+ and tmux `set-clipboard` do over SSH; iTerm2's `OSC 1337 ; Copy` and kitty's OSC 5522 writes too. Writes only: a query (`52;c;?`) is never answered. Only the clipboard (`c`, or an empty or unknown selection) is written; `s` and `p` are ignored, as in Ghostty on macOS. A write is held back after each connect until you press a key or click in the tab, so the replayed history never overwrites the clipboard, and the browser may still refuse it (Chrome needs focus, Firefox recent input, Safari refuses most): the console says so once. `false` ignores all program clipboard writes. See [ADR 052](../adrs/052.client.osc52-clipboard-write.md). |
| `bellTitle` | boolean | `true` | When a program rings the bell (BEL), put a 🔔 in front of the tab title until the terminal is focused or a key is pressed, as Ghostty's `bell-features = title` does; it shows in a background tab until you come back. Bells in the output replayed on reload or reconnect are ignored. The tab title itself is the program's title (OSC 0/2) as `<title> \| webtty`, or `<session> \| webtty` while it has none. `false` leaves the title alone on a bell. See [ADR 053](../adrs/053.client.focus-reports-title-and-bell.md). |
| `desktopNotifications` | boolean | `true` | Let programs show desktop notifications with OSC 9 (`ESC ] 9 ; <body> BEL`) and OSC 777 (`ESC ] 777 ; notify ; <title> ; <body> BEL`), as Ghostty's `desktop-notifications`; ConEmu's `OSC 9 ; <n>` forms (`9;4` progress) are not notifications. They show as browser notifications while the terminal is not focused, at most one a second, and clicking one returns to the tab. The browser asks for permission on your next key or click after the first one (never on load); until it is granted, or over http other than localhost, the tab title gets the bell's 🔔 instead (off with `bellTitle: false`). Notifications in the output replayed on reload or reconnect are ignored. `false` ignores them all. See [ADR 056](../adrs/056.client.desktop-notifications.md). |
| `mouseScrollSpeed` | number | `1` | Mouse wheel scroll speed multiplier for apps with mouse tracking (e.g. vim `set mouse=a`). `1` = one scroll report (SGR 64/65 under mode 1006) per wheel tick (default). Applies to line/page wheel deltas only: pixel deltas (trackpads, macOS Chromium/Safari wheels) always send one SGR event per cell height scrolled, 1:1 with the OS. Values `< 1` reduce rate (e.g. `0.5` fires every other tick); values `> 1` send multiple SGRs per tick. Must be `> 0`. |
| `padding` | number | `0` | Padding in px around the terminal canvas, on all four sides. The canvas is fitted to whole cells, so a few extra pixels can remain on top of this: on the right and at the bottom. The top and left gap is exactly `padding`. The padding is coloured by `theme.padding`, or `theme.background` if that is unset. |
| `logs` | boolean | `false` | Write server stdout/stderr to `~/.config/webtty/server.log`. Appends on each start. Default `false` — server runs silently. |
| `fontSize` | number | `13` | Font size in px |
| `fontFamily` | string | `"Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'"` | CSS font-family stack. See [Default font stack](#default-font-stack). |
| `theme` | object | Campbell | Terminal color palette — see theme keys below |
| `keyboardBindings` | array | `[]` | Custom key-to-sequence bindings sent to the PTY. See [key-bindings spec](key-bindings.md) for schema and examples. |


### Default font stack

Chrome draws a grapheme cluster in the first font of the stack that has every codepoint in it, or in a system fallback font. Menlo has no enclosing marks (U+20DD-U+20E0), so `a⃝` or `1⃝` came out as a missing-glyph box. `'STIX Two Text'` (shipped with macOS) has them and is added last, so it is used only for clusters no earlier font covers whole: the cell size, which is measured from the first available font, and every glyph Menlo or the system fallback drew before stay the same. The exceptions are about 120 other characters Menlo lacks, which now come from STIX Two Text instead of the system fallback: letterlike symbols (`℃`, `ℹ`, `ℓ`), some currency signs (`₹`, `₺`, `₽`), modifier letters and phonetic extensions (`ᴀ`, `ᶁ`), historic Cyrillic (`Ѣ`, `Ѫ`), `ẞ`, some punctuation (`‖`, `※`, `⁄`) and ligatures (`ﬀ`). It goes last rather than after Menlo because on Linux or Windows, where Menlo is missing, a STIX font installed there would otherwise become the cell font; where it is not installed, the name is skipped. `'STIX Two Math'` covers the same marks but also draws its own symbols in the Private Use Area that Powerline and Nerd Font glyphs use, so a missing-glyph box became an unrelated glyph; `STIXGeneral` takes over about 2,000 math symbols from the system fallback. Neither font covers U+20E3 (keycap) without VS16, so `1⃣` stays a box.

A `fontFamily` written in `config.json` replaces the whole stack, so it keeps whatever it was set to; append `'STIX Two Text'` to it to get the marks. The first run writes only `port` and `host`, so a config without `fontFamily` gets the new default.

### Theme keys

All theme keys are optional; omitted keys fall back to the Campbell (Windows Terminal default) palette.

| Key | Default | Description |
|-----|---------|-------------|
| `background` | `#000000` | Terminal background |
| `foreground` | `#CCCCCC` | Default text color |
| `cursor` | `#FFFFFF` | Cursor color |
| `selection` | `#FFFFFF` | Selection highlight (background) |
| `selectionForeground` | *(same as `background` when `selection` is set)* | Text colour inside the selection |
| `searchBackground` | `#FFE082` | Background of find matches ([ADR 055](../adrs/055.client.find-in-scrollback.md); Ghostty's `search-background`) |
| `searchForeground` | `#000000` | Text colour of find matches |
| `searchSelectedBackground` | `#F2A57E` | Background of the selected find match |
| `searchSelectedForeground` | `#000000` | Text colour of the selected find match |
| `padding` | *(same as `background`)* | Colour of the padding set by the top-level `padding` setting. A colour only. The few pixels left when the canvas is fitted to whole cells are not coloured by this: the client always extends the edge cells' own background into them (like Ghostty's `window-padding-color = extend`). Set it to a full-screen app's edge colour (for example a sidebar) to hide the strip. A webtty setting, not a terminal colour, so it is not sent to the terminal. |
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
  "scrollbackLines": 10000,
  "cols": 80,
  "rows": 24,
  "cursorStyle": "bar",
  "cursorStyleBlink": true,
  "copyOnSelect": true,
  "rightClickBehavior": "contextMenu",
  "clipboardWrite": true,
  "bellTitle": true,
  "desktopNotifications": true,
  "fontSize": 13,
  "fontFamily": "Menlo, Consolas, 'DejaVu Sans Mono', monospace, 'STIX Two Text'",

  "keyboardBindings": [
    { "key": "enter", "mods": ["shift"], "chars": "\u001b\r" }
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

## Code structure

`src/config/` holds the schema types (including `ClientConfig` and `CLIENT_CONFIG_KEYS`, the keys `GET /api/config` sends), the defaults, the pure parser, the binding merge rules and the file I/O; `src/config/index.ts` keeps the `../config` import path. The client imports these types with `import type` only ([ADR 059](../adrs/059.architecture.code-organisation.md), [ADR 062](../adrs/062.server.composition.md), [architecture SPEC](architecture.md)).

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Config lifecycle | First-run write, merge with defaults, env overrides, hot-reload on tab reload | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Server settings | `port`, `host` — locked at startup; `shell`, `term`, `colorTerm` — applied per new PTY. `term` defaults to `xterm-256color` (not inherited from parent process) | [ADR 008](../adrs/008.webtty.config.md), [ADR 016](../adrs/016.config.term-default.md) | ✅ |
| Terminal appearance | `cols`, `rows`, `fontSize`, `fontFamily`, `cursorStyle`, `cursorStyleBlink`, `scrollback`, `theme` — re-read on tab reload | [ADR 008](../adrs/008.webtty.config.md) | ✅ |
| Hot config reload | Appearance re-read on tab reload; shell/PTY settings re-read on new PTY spawn; `port`/`host` locked for server lifetime | [ADR 009](../adrs/009.webtty.config-hot-reload.md) | ✅ |
| Copy behavior | `copyOnSelect` + `rightClickBehavior` — configurable clipboard copy matching VS Code / kitty conventions | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Mouse follows app tracking | While the app tracks the mouse, drags, double clicks and right-clicks go only to the app (no selection, copy or menu), Shift to bypass; `rightClickBehavior` gains `"contextMenu"` (default, was `"default"`), `"paste"` and `"none"` | [ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md) | ✅ |
| Program clipboard writes | `clipboardWrite` (default `true`) lets programs write the clipboard with OSC 52 (writes only, standard clipboard only, held back until input after each connect); `false` ignores them | [ADR 052](../adrs/052.client.osc52-clipboard-write.md) | ✅ |
| Bell in the tab title | `bellTitle` (default `true`) puts 🔔 in front of the tab title after a bell until the terminal is focused or a key is pressed; replayed bells are ignored | [ADR 053](../adrs/053.client.focus-reports-title-and-bell.md) | ✅ |
| Desktop notifications | `desktopNotifications` (default `true`) shows OSC 9 and OSC 777 notifications as browser notifications while the terminal is not focused, with the 🔔 title mark without permission; replayed ones are ignored | [ADR 056](../adrs/056.client.desktop-notifications.md) | ✅ |
| Server logs | `logs: true` appends server stdout/stderr to `~/.config/webtty/server.log` | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Cursor style | `cursorStyle` sets the default cursor shape; DECSCUSR sequences from apps override at runtime, and Ps 0 restores it | [ADR 013](../adrs/013.client.cursor-style.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| Padding | `padding` (px, default `0`) around the terminal canvas, coloured by `theme.padding` or `theme.background` | [ADR 034](../adrs/034.client.padding-config.md) | ✅ |
| Mouse scroll speed | `mouseScrollSpeed` scales SGR events per wheel tick for apps with mouse tracking; default `1` | [ADR 017](../adrs/017.client.mouse-scroll.md) | ✅ |
| Scrollback in lines | `scrollbackLines` (default `10000`, `0` = no line limit) sets terminal history in lines under a 32 MiB ceiling; `scrollback` stays the server replay buffer, so existing configs keep their meaning | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 046](../adrs/046.client.scrollback-lines.md), [ADR 047](../adrs/047.client.official-engine-only.md) | ✅ |
| Keyboard bindings | `keyboardBindings` — configurable key-to-sequence mappings sent to PTY; defaults to `[]` | [ADR 018](../adrs/018.key-bindings.config-support.md), [key-bindings spec](key-bindings.md) | ✅ |
| Env injection | `env` — flat `Record<string,string>` merged over `process.env` and injected into PTY shells and execute commands; same contract as `~/.claude/settings.json` | [ADR 030](../adrs/030.config.env-inject.md) | ✅ |
