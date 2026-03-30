# SPEC: Key Bindings

**Last Updated:** 2026-03-29

---

## Description

Browser `KeyboardEvent` objects carry no terminal escape sequence knowledge. When a user presses Shift+Enter in webtty, ghostty-web receives a `keydown` with `key="Enter"` and `shiftKey=true` — and sends `\r` to the PTY, identical to plain Enter. TUI apps that distinguish modifier+key combos (e.g. opencode expecting Shift+Enter as a "new line" action) never receive the sequence they expect.

`keyboardBindings` solves this with a config-driven mapping layer. A capture-phase `keydown` listener intercepts matching combos before ghostty-web sees them and sends the configured `chars` directly to the PTY.

## Binding schema

`keyboardBindings` is an array of binding objects in `~/.config/webtty/config.json`. Each entry has the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | string | yes | Key name, matched case-insensitively against `KeyboardEvent.key`. Special keys: `"enter"`, `"escape"`, `"tab"`, `"backspace"`, `"delete"`, `"space"`, `"arrowup"`, `"arrowdown"`, `"arrowleft"`, `"arrowright"`, `"f1"`–`"f12"`. Printable characters: `"a"`–`"z"`, `"0"`–`"9"`, etc. |
| `mods` | string[] | no | Array of modifier names. Accepted values: `"shift"`, `"ctrl"`, `"alt"`, `"meta"`. Unknown values are silently filtered out at config load. Order does not matter — `["ctrl", "shift"]` and `["shift", "ctrl"]` are equivalent. Omit or `[]` for no modifiers. |
| `chars` | string | yes | Byte sequence sent verbatim to the PTY. Must be a valid JSON string — use `\uXXXX` for non-printable bytes (e.g. `"\u001b"` for ESC). `\x` hex notation is **not valid JSON** and will cause a parse error. Standard escapes `\r`, `\n`, `\t` work as expected. All escapes are resolved by `JSON.parse` at config load; the string is sent as-is with no further processing. |

`keyboardBindings` defaults to `[]`. No bindings ship with webtty — users opt in by adding entries in `~/.config/webtty/config.json`.

User entries are **merged with defaults by `(key, mods)` identity**:

- A user entry whose `(key, mods)` matches a default replaces that default.
- All other defaults are preserved.
- To consume a key without sending anything, set `"chars": ""`.

## Defining `chars`

The `chars` value is the byte sequence the target TUI app expects for that key combo. Two encoding approaches exist:

| Approach | Example (Shift+Enter) | Compatibility |
|---|---|---|
| Legacy encoding | `"\u001b\r"` | Works across all terminal chains |
| [Kitty Keyboard Protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) (KKP) | `"\u001b[13;2u"` | Works in direct single-hop setups only |

**Legacy encoding is recommended for general use.** Legacy escape codes require no capability negotiation — they pass through every terminal layer unconditionally. KKP sequences are only reliable when the app negotiates directly with webtty. In nested terminal setups (e.g. running a TUI app inside vim `:terminal`, tmux, or screen), the intermediate emulator does not forward KKP capability negotiation, so the app never enters KKP mode and the sequence is silently ignored. See [ADR 019](../adrs/019.key-bindings.sequence-compat.md) for the full analysis.

### Legacy encoding

Legacy escape codes are convention-based: ESC followed by the unmodified key bytes. There is no in-band handshake — meaning is agreed by convention between the terminal and the app.

Common examples:

| Key combo | `chars` |
|---|---|
| Shift+Enter | `"\u001b\r"` |
| Alt+Enter | `"\u001b\r"` (same as Shift+Enter in many apps — check app docs) |

#### Discovering sequences

Run `webtty key` — it puts the terminal in raw mode and prints the `chars` value ready to copy-paste for each key combo you press:

```sh
webtty key
# Press any key combo to see its chars value. q to quit.
#
#   received →  chars
#   -----------------
#   ESC CR   →  "\u001b\r"
#   \x04     →  "\u0004"
#   S        →  "S"
```

If the captured sequence still does nothing, the app may expect a different convention. Check the app's documentation or source for what sequence it registers as its key handler.

#### Porting from another terminal

| App | Shift+Enter example | How to convert to `chars` |
|---|---|---|
| Alacritty | `chars = "\u001B\r"` | `\uNNNN` copies as-is (case-insensitive); `\xHH` → `\u00HH` (pad to 4 digits) |
| Ghostty | `keybind = shift+enter=text:\x1b\r` | `\xHH` → `\u00HH`; `\r`, `\n`, `\t` copy as-is |
| VS Code Terminal | `"args": { "text": "\u001b\r" }` | `\uNNNN` copies as-is |
| Windows Terminal | `"input": "\u001b\r"` | `\uNNNN` copies as-is |
| iTerm2 | `0x1b 0x0d` ("Send Hex Code") | Split on spaces; each `0xHH` → `\u00HH` (e.g. `0x1b 0x0d` → `"\u001b\r"`) |

### Kitty Keyboard Protocol

KKP sequences are structured and derivable from a formula. Use them only when you are certain the app runs directly against webtty with no intermediate terminal emulator.

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

Common keycodes:

| Key | Keycode | Shift example |
|---|---|---|
| Enter | 13 | `"\u001b[13;2u"` |
| Tab | 9 | `"\u001b[9;2u"` |
| Backspace | 127 | `"\u001b[127;2u"` |
| Escape | 27 | `"\u001b[27;2u"` |
| Space | 32 | `"\u001b[32;2u"` |

Full keycode table: [kitty keyboard protocol — functional key definitions](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional-key-definitions).

## Binding examples

| Use case | `key` | `mods` | Legacy `chars` | KKP `chars` | Reason |
|---|---|---|---|---|---|
| Shift+Enter | `"enter"` | `["shift"]` | `"\u001b\r"` | `"\u001b[13;2u"` | Most terminal emulators don't distinguish Shift+Enter from Enter by default; explicit binding required for apps like opencode (see [#1505](https://github.com/anomalyco/opencode/issues/1505)) |
| Ctrl+Enter | `"enter"` | `["ctrl"]` | not supported (Ctrl+key legacy maps only A–Z to control chars `0x01`–`0x1A`; Enter has no equivalent) | `"\u001b[13;5u"` | Distinguish "run command" from "new line" in multi-line prompts; no legacy encoding exists for Ctrl+Enter |
| Ctrl+w | `"w"` | `["ctrl"]` | `"\u0017"` | `"\u0017"` | Browser intercepts Ctrl+W to close the tab; this binding suppresses that and forwards the keystroke to the PTY (e.g. vim window command) |
| Suppress F5 | `"f5"` | `[]` | `""` | `""` | Browser intercepts F5 to reload the page; empty `chars` consumes the key without sending anything to the PTY |

## Client implementation

A capture-phase `keydown` listener on the terminal container fires before ghostty-web's canvas handlers and intercepts matching bindings:

1. Walk `config.keyboardBindings`.
2. Normalize `event.key` to lowercase and compare against each binding's `key` + `mods`.
3. On match: call `e.preventDefault()` + `e.stopPropagation()` to suppress ghostty-web's default handling, then send `binding.chars` verbatim over WebSocket to the PTY.
4. No match: return immediately — ghostty-web handles as normal.

`stopPropagation` (not `stopImmediatePropagation`) is sufficient: it prevents the event from reaching the canvas so ghostty-web never fires its default handling.

`chars` is sent verbatim. Standard JSON escapes (`\uXXXX`, `\r`, `\n`, `\t`) are resolved by `JSON.parse` at config load — no further processing occurs at send time.

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Configurable bindings | `keyboardBindings` array in `~/.config/webtty/config.json`; capture-phase `keydown` handler sends `chars` to PTY; defaults to `[]` | [ADR 018](../adrs/018.key-bindings.config-support.md) | ✅ |
| Legacy encoding recommendation | `"\u001b\r"` recommended over KKP sequences for Shift+Enter and similar combos; works across nested terminal chains | [ADR 019](../adrs/019.key-bindings.sequence-compat.md) | ✅ |
| `webtty key` | CLI command: puts terminal in raw mode, prints the `chars` value for each key combo pressed; q to quit | [ADR 020](../adrs/020.cli.key.md) | ✅ |
