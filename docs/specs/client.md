# SPEC: Client

**Last Updated:** 2026-10-14

---

## Description

The webtty browser client runs entirely in the browser. It is served as static assets — no server-side HTML rendering, no inline scripts. This makes it CSP-safe (`script-src 'self'` is sufficient) and gives the client code a proper TypeScript foundation for future enhancement.

The client has one surface: a full-viewport terminal view, one session per tab.

**Why static assets?** Inline scripts require `'unsafe-inline'` or a per-request nonce to pass strict CSP. Serving the client as a static JS file loaded via `<script src>` allows `script-src 'self'` with no exceptions. It also enables real TypeScript in the browser — LSP, type checking, imports — rather than an untyped string template. See [ADR 012](../adrs/012.client.static-assets.md).

**Why no framework (React/Vue)?** The client is a single terminal view. A framework adds more complexity than it removes. Revisit when the client grows to multiple pages or components.

## Asset layout

```
dist/
  client.html          ← static HTML shell; served at GET /s/:id
  client-browser.js    ← compiled from src/client/index.ts, with the vendored ghostty-web TS bundled in
  client.css           ← copied from src/client/index.css
  ghostty-vt-small.wasm ← official libghostty-vt (ReleaseSmall), copied from src/client/vendor/ghostty-vt/
                          only if it matches its sidecar's size and sha256; served at GET /ghostty-vt-small.wasm
  THIRD_PARTY_LICENSES ← MIT notices for Coder's ghostty-web TS, Ghostty's libghostty-vt and ghostty-vt-js,
                          from src/client/vendor/ghostty-web/ and src/client/vendor/ghostty-vt/
```

`client.html` loads only `client-browser.js`. The npm `ghostty-web.js` build inlined the wasm as a base64 `data:` URL. The vendored TS is bundled without inlining, so the client fetches the wasm on every page load through an explicit `Ghostty.load('/ghostty-vt-small.wasm')`, and the page depends on the server serving that route as `application/wasm`. It is Ghostty's official libghostty-vt wasm, the only engine ([ADR 042](../adrs/042.client.official-vt-engine.md), [ADR 047](../adrs/047.client.official-engine-only.md)). The server resolves it from `dist/` (npm install) or the vendored path (local dev); nothing comes from `node_modules` ([ADR 041](../adrs/041.client.libghostty-vt.md)). `GET /ghostty-vt.wasm`, the Coder engine's wasm until ADR 047, returns 404, and `?engine=` in a page URL is ignored.

## Source layout

The client's folders, module kinds, dependency rules, size limits and test conventions are in the [architecture SPEC](architecture.md) ([ADR 059](../adrs/059.architecture.code-organisation.md), [ADR 060](../adrs/060.client.feature-modules.md), [ADR 061](../adrs/061.client.vendor-split.md)). In short:

```
src/client/
  index.ts             ← browser entry, bundled to dist/client-browser.js
  client.html          ← HTML shell (no inline script), copied to dist/client.html
  index.css            ← terminal and find-bar styles, copied to dist/client.css
  *.ts                 ← app modules: the connection, layout and features (moving into app/, connection/,
                          layout/ and features/ as ADR 060 lands)
  vendor/
    ghostty-web/       ← derived from coder/ghostty-web lib/ at 1858a59 and heavily modified by webtty, MIT LICENSE,
                          PROVENANCE.md (upstream pin, local changes, moves and splits);
                          ghostty.ts holds every wasm call, the binding to the official wasm (ADR 042, ADR 047);
                          fn-table.ts is the function-table trampoline borrowed from ghostty-vt-js (LICENSE.ghostty-vt-js)
    fixtures/          ← PTY captures replayed in 1-byte and 512-byte writes by vendor/official-replay.test.ts
    ghostty-vt/        ← official ghostty-vt-small.wasm (Ghostty 05dcf887, ReleaseSmall) + .minisig + sidecar
                          (commit, URL, size, sha256, signature, key, licence), Ghostty LICENSE, PROVENANCE.md;
                          checked offline by vendor/ghostty-vt.test.ts (size, sha256, minisign signature)
scripts/update-ghostty-vt.ts ← fetches and verifies a new pin (the only networked step); --verify re-checks offline
```

The vendored TS is excluded from Biome so Coder's lines are not reformatted and webtty's edits stay readable as diffs, and is type-checked with the rest of `src/`. webtty's edits to it are tracked in git and listed in its `PROVENANCE.md`. `vendor/ghostty-vt/` is excluded from Biome too, since the update script writes its sidecar; nothing in it is edited.

## Page

`GET /s/:id` returns `dist/client.html` — a static HTML shell. On load, `client-browser.js`:

1. Reads `sessionId` from `window.location.pathname` (`/s/main` → `main`)
2. Fetches `GET /api/config` to get terminal config
3. Sets `document.title` to `sessionId + ' | webtty'` through `TabTitle`, which later shows the program's title and the bell mark ([ADR 053](../adrs/053.client.focus-reports-title-and-bell.md))
4. Loads the official libghostty-vt wasm and initialises the vendored ghostty-web `Terminal` with config values (cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink, scrollbackLines, mouseScrollSpeed, theme, copyOnSelect, rightClickBehavior)
5. Connects to `ws://<host>/ws/:id/pty?cols=<cols>&rows=<rows>&flow=1` over WebSocket, and acknowledges output as it parses it: `{ type: 'ack', chars }`, the characters parsed since connecting, every 64 Ki characters and 100 ms after output stops (ADR 048)
6. Fits the terminal to the viewport from the full container size (no scrollbar reserve, see ADR 033) and observes resize events
7. Sends a `{ type: 'resize', cols, rows }` JSON message on open and on every terminal resize
8. Forwards all keystrokes to the PTY via `term.onData`

## Config endpoint

`GET /api/config` returns client-relevant config keys as JSON:

```ts
{
  cols, rows, fontSize, fontFamily, cursorStyle, cursorStyleBlink,
  scrollback,             // the server's replay buffer; the client does not read it (ADR 047)
  scrollbackLines,        // history in lines, 0 = no line limit, 32 MiB ceiling (ADR 046)
  theme, copyOnSelect, rightClickBehavior,
  clipboardWrite,         // Terminal option: report OSC 52 clipboard writes (ADR 052)
  bellTitle,              // TabTitle: 🔔 in the tab title after a bell (ADR 053)
  desktopNotifications,   // Terminal option: report OSC 9 / OSC 777 notifications (ADR 056)
  mouseScrollSpeed,       // Terminal option: SGR wheel ticks per line/page event when the app tracks the mouse
  padding,                // px around the canvas, used by fit(); coloured by theme.padding or theme.background
  keyboardBindings        // used by the keydown capture handler, not passed to Terminal constructor
}
```

Server-only keys (`port`, `host`, `shell`, `term`, `colorTerm`, `logs`) are not exposed.

## Welcome Banner

On the first WebSocket connection to a session (no existing PTY), the server writes a banner to the terminal:

```
╔══════════════════════════════════════════════════════╗
║                                                      ║
║ [ webtty ]   Terminal UI in the browser              ║
║                                                      ║
║ Run `bunx webtty help` for more information.         ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
```

- `[ webtty ]` — dim brackets, bold yellow name
- Slogan — dim
- Help command — dim italic surroundings, foreground italic for the command itself
- Package runner (`bunx` or `npx`) detected from the server's runtime at startup

## Status Messages

All status messages written to the terminal share a consistent style:

```
[ webtty ] <message>
```

| Event | Message | Behavior |
|-------|---------|----------|
| WS close `4001` (session deleted or shell exited) | `Session removed.` | `window.close()` after 500ms |
| WS close `1001` (server stopped) | `Server stopped.` | `window.close()` after 500ms |
| WS close `4003` (tab fell behind the output) | `Tab fell behind; replaying recent output.` | Terminal reset, reconnect at once |
| WS close (unexpected) | `Connection lost. Reconnecting in 2s...` | Reconnect after 2s |
| WS error | `WebSocket error.` | — |

## Keyboard Bindings

Browser `KeyboardEvent` objects do not carry terminal escape sequences — the browser has no knowledge of the Alacritty/Ghostty custom-binding convention that maps modifier+key combos to specific byte sequences. As a result, keys like Shift+Enter arrive at ghostty-web as a plain `keydown` with `shiftKey=true`, and ghostty-web sends the same `\r` it would for unmodified Enter — not the `\x1b\r` (ESC CR) that TUI apps such as opencode expect.

A capture-phase `keydown` listener on the terminal container fires before ghostty-web's canvas handlers and intercepts matching bindings:

1. Walk `config.keyboardBindings` (user-configured entries).
2. Normalize `event.key` to lowercase and compare against each binding's `key`+`mods`.
3. On match: call `e.preventDefault()` + `e.stopPropagation()` to suppress ghostty-web's default handling, then send `binding.chars` verbatim over WebSocket to the PTY.
4. No match: return immediately — ghostty-web handles as normal.

**`chars` encoding:** The client sends `binding.chars` verbatim. Standard JSON escapes (`\uXXXX`, `\r`, `\n`, `\t`) are resolved by `JSON.parse` at config load — no further processing occurs.

See [key-bindings spec](key-bindings.md) for the binding object schema and examples.

## Font-size Zoom

`Ctrl/Cmd` + `=`, `-`, or `0` adjust the terminal font size in-session, matching VS Code and native terminal conventions. These shortcuts are **not configurable** — they are a fixed client-side UI gesture, not PTY input, and cannot be overridden via `keyboardBindings`.

| Key | Action |
|-----|--------|
| `Ctrl/Cmd` + `=` or `+` | Increase font size by 1 (max 32) |
| `Ctrl/Cmd` + `-` | Decrease font size by 1 (min 6) |
| `Ctrl/Cmd` + `0` | Reset to `config.fontSize` (clamped to 6–32) |

Numpad `+`, `-`, and `0` are also recognised.

A capture-phase `keydown` listener on `window` fires first. It calls `preventDefault()` to suppress browser page-zoom and `stopPropagation()` to prevent the key from reaching ghostty-web's PTY input path. Font size is not persisted — reload returns to `config.fontSize`.

See [ADR 023](../adrs/023.client.font-size-zoom.md).

## Copy Behavior

Controlled by two config keys from `GET /api/config`:

| Config | Default | Behavior |
|--------|---------|----------|
| `copyOnSelect` | `true` | Copies a mouse selection (drag, double or triple click) to the clipboard once, on mouseup, through the Terminal's `copyOnSelect` option, and clears it; off, nothing is copied and the selection stays. |
| `rightClickBehavior` | `"contextMenu"` | What a right-click the app does not take does: `"contextMenu"` the browser menu (over the textarea, so it offers Copy and Paste); `"copyPaste"` copy and clear a selection, else the menu; `"paste"` paste the clipboard (the Ctrl+V path, ADR 037); `"none"` nothing, no menu. `"default"` is read as `"contextMenu"`. |

Both can be active simultaneously. The canvas-based terminal has no DOM text selection — these and the copy keys (Cmd+C, Ctrl+Shift+C, Ctrl+Insert; see below) are the only reliable copy paths.

**The app's mouse comes first** ([ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md)). While the app tracks the mouse (any DEC mouse tracking mode), a press is the app's unless Shift is held, as in Ghostty, kitty, WezTerm, xterm, Windows Terminal and VS Code. `mouse-route.ts` holds the rule (`pressToApp`, `rightClickAction`), and the input handler, the selection manager and the terminal all ask it:

| | Left drag, double/triple click | Right-click |
|---|---|---|
| App does not track the mouse | webtty selects; copied on release with `copyOnSelect` | `rightClickBehavior` |
| App tracks the mouse | only the app gets press, motion and release; no highlight, no copy | only the app gets it; browser menu cancelled |
| App tracks the mouse, Shift held | webtty selects and copies; the app gets nothing for that button until it is released | `rightClickBehavior`; the app gets nothing |

The terminal has the one `contextmenu` listener (`handleContextMenu`). Keys, text and paste clear the selection; mouse reports do not, so a Shift selection survives the app's hover and clicks until Shift+right-click or the menu's Copy uses it. A menu not preceded by a right press (or macOS Ctrl+click) since the last key is a keyboard menu and follows `rightClickBehavior` even while the app tracks the mouse. While the terminal has focus, the Menu key and Shift+F10 are sent to the app as keys, so the browser opens no keyboard menu there. `"paste"` fires `Terminal.onPasteRequest`, which `index.ts` answers with the same clipboard read as Ctrl+V.

What a double or triple click selects, and the text either path copies, is Ghostty's (`ghostty_terminal_select_word`, `ghostty_terminal_select_line`, `ghostty_terminal_selection_format_alloc`): soft-wrapped rows are joined without a newline ([ADR 050](../adrs/050.client.selection-from-libghostty-vt.md)). A triple click with Ctrl or Cmd held selects the output of the command under the pointer instead (`ghostty_terminal_select_output`, from OSC 133 marks; nothing outside output), as in Ghostty ([ADR 057](../adrs/057.client.shell-integration-prompt-jumps.md)).

## Copy, Paste and Clear Keys

Ghostty's default copy, paste and clear-screen keys, for the browser's platform (`navigator.userAgentData.platform`, else `navigator.platform`; macOS and iOS take Ghostty's macOS defaults) ([ADR 054](../adrs/054.client.copy-paste-clear-keys.md)):

| Platform | Key | Action | When it cannot be done |
|---|---|---|---|
| macOS | Cmd+C | copy the selection (input handler) | browser default |
| macOS | Cmd+V | paste (browser `paste` event) | |
| macOS | Cmd+K | clear the screen and scrollback | the app gets the key (alternate screen) |
| others | Ctrl+Shift+C | copy the selection | the app gets the key (`\x03`) |
| others | Ctrl+Insert | copy the selection | consumed, nothing sent |
| others | Shift+Insert | paste the clipboard (a page cannot read the primary selection) | |
| all | Ctrl+V, also with Shift or Alt | paste (ADR 014) | |

Ctrl+C is always the app's. Modifiers match exactly except for Ctrl+V. `features/keyboard/shortcut-map.ts` maps the `keydown` (`shortcutFor`); one capture listener on the container in `index.ts`, after the `keyboardBindings` listener, performs it and steps aside for any combo `keyboardBindings` has, so a binding (even `"chars": ""`) wins. A paste reads `navigator.clipboard.readText` (a failed read sends Ctrl+V); without the API the key is kept from the app and the browser's own paste may fire the `paste` event.

**Cmd+K** is Ghostty's `clear_screen`, done by `Terminal.clearScreen()` with VT sequences written to the terminal, never the PTY:

- on the alternate screen, nothing: the key goes to the app (the encoder sends `k`);
- at a shell prompt (`cursorAtPrompt`, `GHOSTTY_TERMINAL_DATA_CURSOR_AT_PROMPT`, which needs OSC 133 marks, as fish 4 sends): `CSI 2 J` then `CSI 3 J`, and FF to the shell, which redraws its prompt at the top;
- otherwise: the rows above the cursor scroll off (`CSI n S`, `CSI n A`), so the cursor's row is the top one, then `CSI 3 J`.

The sequences go in only where the output is at ground: if the last message ended inside a sequence, the clear waits and is written where the next output finishes it (`ghostty_terminal_vt_write_until_ground`), with the screen, prompt and cursor read then.

The selection and kitty graphics placements are cleared too. The clear is the tab's own: a reload, reconnect or another tab gets the server's replay, scrollback included.

## Find in the Scrollback

The canvas is invisible to the browser's own find, so webtty has Ghostty's search ([ADR 055](../adrs/055.client.find-in-scrollback.md)), run by libghostty-vt (`ghostty_search_*`):

| Platform | Key | Action | When it cannot be done |
|---|---|---|---|
| macOS | Cmd+F | open the find bar (focus it and select its text if open) | |
| macOS | Cmd+Shift+F | close | the app gets the key (bar closed) |
| macOS | Cmd+G / Cmd+Shift+G | next / previous match | the app gets the key (bar closed) |
| others | Ctrl+Shift+F | open the find bar | |
| all | Escape | close | the app gets the key (bar closed) |
| in the field | Enter / Shift+Enter | next / previous match | |

Ctrl+F stays the app's. The keys go through `shortcutFor` and the listener of the copy and paste keys, so `keyboardBindings` win; in the field they are the field's own (`fieldKey` in `features/find/find-keys.ts`).

- **Matching** is Ghostty's: ASCII letters case-insensitively, everything else exactly, soft-wrapped rows joined so a match can span a wrap; scrollback and screen, on the active screen.
- **Order**: next goes toward older output (up), previous toward newer, both wrapping. Nothing is selected until the first Enter; the count is Ghostty's `selected/total` (`0/n` before then).
- **Scrolling**: if no row of the selected match is in view, the view jumps so its first row is the top row. While a match is selected and the view is scrolled up, output does not pull the view to the bottom: it stays on its rows, except on the alternate screen. A key or a paste sent to the program scrolls to the bottom, as in Ghostty (`scroll-to-bottom = keystroke, no-output`); mouse reports do not.
- **Highlights**: every match in `searchBackground` / `searchForeground`, the selected one in `searchSelectedBackground` / `searchSelectedForeground` (Ghostty's defaults); the selection is drawn over both.
- **The bar** (`features/find/find-bar.ts`) is a DOM overlay at the top right, outside `#terminal`, coloured from the theme, with a labelled field, the count in a live region, ↑ (next), ↓ (previous) and × buttons. Typing searches after 150 ms; closing ends the search, clears the highlights and refocuses the terminal, and the field keeps its text for the next open.

`Terminal` (vendored) keeps the needle (also across `reset`), runs the search for at most 4 ms a frame before each render, and reads the matches again when they changed, at most every ten times the last read took; the renderer finds the matches in view by binary search on the newest-to-oldest list, and repaints a row only when its matches change. Find has no side effects, so the replay on connect needs no special handling.

## Shell Prompts (OSC 133)

Shells that mark their prompts with OSC 133 (`133;A` prompt, `133;B` command line, `133;C` output, `133;D;<status>` end) get Ghostty's `jump_to_prompt` and output selection ([ADR 057](../adrs/057.client.shell-integration-prompt-jumps.md)):

| Platform | Key | Action |
|---|---|---|
| macOS | Cmd+↑, Cmd+Shift+↑ | to the previous prompt |
| macOS | Cmd+↓, Cmd+Shift+↓ | to the next prompt |
| others | Ctrl+Shift+↑ / Ctrl+Shift+↓ | to the previous / next prompt |
| all | Ctrl/Cmd + triple click | select the command's output (see Copy Behavior) |

- **The move is Ghostty's** (`GHOSTTY_SCROLL_VIEWPORT_DELTA_PROMPT`): the prompt becomes the view's top row; up from the bottom goes to the nearest prompt above the screen's top row; past the last prompt the view goes to the bottom. The binding's `promptJumpRow` puts Ghostty's viewport on webtty's top row, moves it, reads it back (`GHOSTTY_TERMINAL_DATA_SCROLLBAR`) and returns it to the bottom; `Terminal.jumpToPrompt` scrolls the view with `scrollToLine`, and output still pulls a scrolled view to the bottom.
- The keys are always consumed, as Ghostty's are not `performable:`: without marks, or on the alternate screen, they do nothing and do not reach the app. They go through `shortcutFor` and the listener of the copy and paste keys, so `keyboardBindings` win.
- Nothing is sent anywhere, so the replay needs no special handling; its marks come with it.

**Getting the marks.** webtty does not inject shell integration (ADR 057 records it as a follow-up):

- **fish 4.0 and later** send them with no setup.
- **zsh and bash** send none. Paste webtty's snippet at the end of `~/.zshrc` or `~/.bashrc` ([ADR 058](../adrs/058.client.zsh-bash-prompt-marks.md)); bash 3.2 (macOS `/bin/bash`) has no `PS0`, so it gets the prompt jumps and Cmd+K but not output selection:

  ```zsh
  # ~/.zshrc, at the end. webtty: OSC 133 prompt marks (ADR 058)
  if [[ -o interactive ]]; then
    autoload -Uz add-zsh-hook
    _webtty_precmd() {
      local ret=$?
      (( ${+_webtty_ran} )) && printf '\e]133;D;%s\a' "$ret"
      unset _webtty_ran
      printf '\e]133;A\a'
      [[ $PS1 == *'133;B'* ]] || PS1+=$'%{\e]133;B\a%}'
    }
    _webtty_preexec() { _webtty_ran=1; printf '\e]133;C\a'; }
    add-zsh-hook precmd _webtty_precmd
    add-zsh-hook preexec _webtty_preexec
  fi
  ```

  ```bash
  # ~/.bashrc, at the end. webtty: OSC 133 prompt marks (ADR 058)
  if [[ $- == *i* ]]; then
    _webtty_prompt() {
      local ret=$?
      [[ -n ${_webtty_started-} ]] && printf '\e]133;D;%s\a' "$ret"
      _webtty_started=1
      printf '\e]133;A\a'
      [[ $PS1 == *'133;B'* ]] || PS1+='\[\e]133;B\a\]'
      return "$ret"
    }
    PROMPT_COMMAND="_webtty_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    PS0+=$'\e]133;C\a'
  fi
  ```

- Ghostty's integration scripts also work when sourced by hand (GPLv3; from a Ghostty install or [`src/shell-integration`](https://github.com/ghostty-org/ghostty/tree/main/src/shell-integration)); with `GHOSTTY_SHELL_FEATURES` unset they only send the marks.
- starship (1.26) does not send them.

## Program Clipboard Writes

Programs write the clipboard with OSC 52 (`ESC ] 52 ; c ; <base64> BEL` or ST), as Claude Code, pi, Neovim 0.10+ and tmux `set-clipboard` do over SSH ([ADR 052](../adrs/052.client.osc52-clipboard-write.md)). Ghostty parses and decodes it (also iTerm2's `OSC 1337 ; Copy` and kitty's OSC 5522) and calls the binding's `CLIPBOARD_WRITE` callback, installed only while `clipboardWrite` is on:

| Sequence | Result |
|---|---|
| `52;c;<base64>`, `52;;<base64>`, any selection other than `s`/`p` | the clipboard gets the text, decoded as UTF-8 (invalid bytes become U+FFFD) |
| `52;s;…`, `52;p;…`, `52;pc;…` | nothing, as in Ghostty on macOS |
| `52;c;` (empty) | the clipboard is cleared (set to `''`) |
| `52;c;?` (query) | no answer, ever |
| invalid base64, or a sequence over 8 MiB (about 6 MiB of text) | ignored whole; missing padding is accepted |

`readEffects` reports the last write since the previous call, `Terminal.onClipboardWrite` fires with it, and `index.ts` passes it to `ClipboardWriter` (`features/clipboard/clipboard-writer.ts`), which calls `navigator.clipboard.writeText`. After each (re)connect it ignores writes until a `keydown`, `mousedown`, `paste` or `drop` in the tab, so the replayed history does not overwrite the clipboard on reload. A missing clipboard API (http other than localhost), a refused write (no focus in Chrome, no recent input in Firefox, most writes in Safari) and a write held back for the replay are each logged to the console once; there is no error UI.

## Focus Reports, Title and Bell

Programs hear focus changes, name the tab and ring the bell as in Ghostty ([ADR 053](../adrs/053.client.focus-reports-title-and-bell.md)):

- **Focus reports (mode 1004).** The terminal has focus while keyboard focus is inside the container and the window has focus; `Terminal` follows it with `focusin` / `focusout` on the container (a move inside it, the container passing focus to the textarea, is not a change). While the program has mode 1004 on, each change sends `CSI I` or `CSI O`, encoded by `ghostty_focus_encode`, through `onData`; a write that turns the mode on sends the current state, as Ghostty does when the mode is set, so the replay of a program that has it on tells the program this tab's focus. Each socket that opens with the mode still on (a reconnect without a reset) sends the current state too (`resyncFocus`), since reports while it was down were dropped. Nothing is sent with `disableStdin`.
- **Title.** `TabTitle` (`features/tab-title/tab-title.ts`) sets `document.title` to `<title> | webtty` from `Terminal.onTitleChange` (OSC 0 / OSC 2, read from Ghostty after each write), or `<session> | webtty` while the title is empty. Titles in the replay are applied.
- **Bell.** With `bellTitle` on (default), a BEL puts `🔔 ` in front of the tab title, focused or not, until the terminal gains focus (`focusin` on the container, which a window focus fires too) or a key is pressed, as Ghostty's `bell-features = title`. No sound, flash or notification. Bells in the replay are ignored: from each connect, output is replay through the first WebSocket message shorter than the server's 64 Ki-character replay piece (`REPLAY_PIECE`, the replay's last piece), or until a message arrives 1 s (`REPLAY_QUIET_MS`) after the previous one was parsed; the first message is always replay. `ReplayWindow` (`connection/replay-window.ts`) keeps that state, fed by `index.ts` around each message, for the bell and for desktop notifications.

## Desktop Notifications

Programs ask for desktop notifications with OSC 9 (`ESC ] 9 ; <body> BEL`, iTerm2) and OSC 777 (`ESC ] 777 ; notify ; <title> ; <body> BEL`, rxvt), as Ghostty shows them ([ADR 056](../adrs/056.client.desktop-notifications.md)). Ghostty's parser tells them apart from ConEmu's `OSC 9 ; <n>` forms and calls the binding's `DESKTOP_NOTIFICATION` callback, installed only while `desktopNotifications` is on:

| Sequence | Result |
|---|---|
| `9;<text>` | a notification with no title, body `<text>` (semicolons included) |
| `777;notify;<title>;<body>` | title and body; the body may hold `;`, the title may be empty |
| `9;4;…` (progress), `9;1;…` to `9;12` (ConEmu) | nothing |
| `9;4`, `9;42 tests passed` (not a full ConEmu form) | a notification, as in Ghostty |
| `777;<other>;…`, `777;notify;<title>` (no body) | nothing |

`readEffects` reports every request since the previous call, `Terminal.onDesktopNotification` fires for each, and `index.ts` passes it to `DesktopNotifier` (`features/notifications/desktop-notifier.ts`, with the browser's API behind `browser-notifications.ts`), which, as Ghostty on macOS:

- drops it while `ReplayWindow` says the output is replay;
- shows at most one a second, and the same title and body at most once in five seconds;
- shows nothing while the terminal has focus (window focused, keyboard focus in the container, as for mode 1004);
- otherwise, with permission granted, shows `new Notification(title, { body, tag })`: an OSC 9 notification takes the tab's name (the program's title, or the session id) as its title; the tag (session, title, body) makes a second tab on the session replace rather than stack it. Text is passed as plain text. A click focuses the window and the terminal; the terminal gaining focus or a key closes every notification it showed;
- otherwise (permission not granted, no API over http or on iOS Safari, a constructor that throws as on Chrome for Android) puts the bell's `🔔 ` in front of the tab title, which `bellTitle: false` turns off too. Each reason is logged to the console once.

Permission is never asked on load. The first live notification while it is `default` (focused or not) arms the request, and the next `keydown` or `mousedown` in the tab that gives the page user activation (`navigator.userActivation.isActive`; without it, any but Esc) calls `Notification.requestPermission()`, once per page load. Esc, which does not, leaves the request armed.

## Behavior Notes

### Tab close on session end

When a session ends (shell exits → WS close code `4001`) or the server stops (`webtty stop` → WS close code `1001`), the client calls `window.close()` after 500ms.

**Browser restriction**: `window.close()` is only permitted on tabs opened programmatically via `window.open()` or duplicated from such tabs.

- Tabs opened by `webtty at` → close automatically ✅
- Tabs opened by manually navigating to the server URL → display the status message but remain open ⚠️

## Features

| Feature | Description | ADR | Done? |
|---------|-------------|-----|-------|
| Static asset build | Browser TS compiled by `Bun.build()`; HTML/CSS copied to `dist/`; zero inline script | [ADR 012](../adrs/012.client.static-assets.md) | ✅ |
| Terminal view | Full-viewport terminal using `ghostty-web`, auto-fit, WebSocket reconnect on disconnect | [ADR 001](../adrs/001.webtty.bootstrap.md) | ✅ |
| Config endpoint | `GET /api/config` — serves client-relevant config keys; replaces server-side template injection | [ADR 012](../adrs/012.client.static-assets.md) | ✅ |
| Session support | `GET /s/:id` opens a named session; `GET /` redirects to last-used or creates `main` | [ADR 005](../adrs/005.client.session-support.md) | ✅ |
| Multi-client | Multiple tabs can attach to the same session; scrollback replayed on reconnect; tab closes when PTY exits | [ADR 007](../adrs/007.webtty.session-client.md) | ✅ |
| Output acknowledgements | Output is acknowledged as it is parsed, so the server sends it in order at the tab's pace; a tab closed with `4003` for falling behind resets and reconnects to the replay | [ADR 048](../adrs/048.webtty.output-flow-control.md) | ✅ |
| Welcome banner and status messages | `[ webtty ]`-styled banner on first connect; consistent status messages for disconnect, error, and server stop | [ADR 010](../adrs/010.client.ux-polish.md) | ✅ |
| Copy behavior | `copyOnSelect` + `rightClickBehavior` — two independent configurable copy modes | [ADR 011](../adrs/011.cli.config-and-help.md) | ✅ |
| Program clipboard writes (OSC 52) | OSC 52 (and OSC 1337 Copy, OSC 5522) writes from programs reach the browser clipboard: writes only, the standard clipboard only, UTF-8 text, held back after each connect until the user acts in the tab so the replay never writes; `clipboardWrite: false` turns it off | [ADR 052](../adrs/052.client.osc52-clipboard-write.md) | ✅ |
| Copy, paste and clear keys | Ghostty's defaults for the browser's platform: Ctrl+Shift+C and Ctrl+Insert copy and Shift+Insert pastes outside macOS (Ctrl+C stays the interrupt; Ctrl+Shift+C with no selection goes to the app), Cmd+K clears the screen and scrollback on macOS (at an OSC 133 prompt with FF for the shell to redraw; the app's key on the alternate screen); `keyboardBindings` win | [ADR 054](../adrs/054.client.copy-paste-clear-keys.md) | ✅ |
| Find in the scrollback | Cmd+F (macOS) or Ctrl+Shift+F opens a find bar; libghostty-vt's search over scrollback and screen (ASCII case-insensitive, across soft wraps), every match highlighted and the selected one distinct in Ghostty's colours, Enter / Shift+Enter (Cmd+G / Cmd+Shift+G) to the next (older) and previous match with Ghostty's `k/n` count, the view jumping to a match out of view and kept on it while output streams, Escape to close; `keyboardBindings` win | [ADR 055](../adrs/055.client.find-in-scrollback.md) | ✅ |
| Shell prompts (OSC 133) | Cmd+↑ / Cmd+↓ (also with Shift) on macOS, Ctrl+Shift+↑ / Ctrl+Shift+↓ elsewhere jump the view to the previous / next prompt, as Ghostty's `jump_to_prompt` (libghostty-vt's `DELTA_PROMPT`), consumed even with no prompt; Ctrl/Cmd+triple-click selects a command's output; marks from fish 4 natively, or zsh and bash with webtty's snippet ([ADR 058](../adrs/058.client.zsh-bash-prompt-marks.md)); no injection yet; `keyboardBindings` win | [ADR 057](../adrs/057.client.shell-integration-prompt-jumps.md) | ✅ |
| Desktop notifications | OSC 9 and OSC 777 `notify`, parsed by Ghostty (ConEmu's `9;<n>` forms excluded), shown as browser notifications while the terminal is not focused, one a second and the same one once in five seconds; permission asked on the next key or click after the first one; the 🔔 title mark without permission; replayed ones ignored; `desktopNotifications: false` turns them off | [ADR 056](../adrs/056.client.desktop-notifications.md) | ✅ |
| Focus reports, title and bell | Mode 1004 focus reports encoded by Ghostty, sent on each change and when the mode is set; the tab title is the program's OSC 0/2 title (`<title> \| webtty`, the session id while it has none); a bell puts 🔔 in front of it until the terminal is focused or a key is pressed, and bells replayed on connect are ignored; `bellTitle: false` turns the mark off | [ADR 053](../adrs/053.client.focus-reports-title-and-bell.md) | ✅ |
| Mouse follows app tracking | While the app tracks the mouse, drags, double/triple clicks and right-clicks go only to the app: webtty draws no highlight, copies nothing and cancels the browser menu. Shift selects in webtty (and applies `rightClickBehavior`) and sends nothing to the app. `rightClickBehavior` is `"contextMenu"` (default), `"copyPaste"`, `"paste"` or `"none"`, all handled in one function | [ADR 051](../adrs/051.client.mouse-tracking-selection-and-right-click.md) | ✅ |
| Cursor style | `cursorStyle` / `cursorStyleBlink` are Ghostty's default cursor; Ghostty applies DECSCUSR from the PTY (Ps 0 and RIS restore the default); mode 12 is ignored, as in Ghostty with `cursor-style-blink` set; and the renderer draws the shape and blink from its state, repainting the cursor cell so the old shape does not linger | [ADR 013](../adrs/013.client.cursor-style.md), [ADR 015](../adrs/015.client.cursor-ghost-repaint.md), [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| Non-text paste | Ctrl+V with no `text/plain` in clipboard forwards `\x16` to PTY; TUI apps read non-text content via their native OS clipboard API | [ADR 014](../adrs/014.client.image-paste.md) | ✅ |
| Multiline text paste | Text is encoded by Ghostty's `ghostty_terminal_paste`: bracketed whenever mode 2004 is enabled (single lines too), control bytes replaced with spaces, and without 2004 sent with newlines as CR (they may act as Enter in apps without bracketed paste), never Ctrl+V | [ADR 037](../adrs/037.client.multiline-text-paste.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| IME / dictation at cursor | The terminal keeps focus on its input textarea, which follows the cursor cell; the composition shows at the cursor in the theme's font and colours instead of as a stray line under the canvas | [ADR 038](../adrs/038.client.ime-composition-at-cursor.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Device pixel ratio changes | Moving to a monitor with a different scale, or changing zoom, is followed by the renderer, which repaints instead of staying blurry until reload; fractional ratios render at the next whole ratio so the canvas doesn't resize every frame | [ADR 039](../adrs/039.client.device-pixel-ratio-change.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Pixel-smooth scrollback | Trackpad scrolling through scrollback moves by pixels (the renderer's overscan canvas moved by the offset, ADR 043; the one-row strip is gone); in mouse-tracking apps, pixel deltas send one scroll tick per cell height of travel | [ADR 040](../adrs/040.client.pixel-smooth-scroll.md), [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Vendored terminal layer | The terminal (renderer, input, selection) is webtty's own vendored code with no npm `ghostty-web` dependency; terminal behaviour is unchanged | [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| ghostty-web bugs fixed at source | ghostty-web bugs are fixed in the vendored code instead of patched from outside, each fix deleting its webtty workaround (hover motion, cursor interceptor, fit reserve, private `devicePixelRatio` set, and the rest of ADR 041 step 2) | [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Official libghostty-vt engine, opt-in | `?engine=official` runs the terminal on Ghostty's official, unpatched libghostty-vt wasm (pinned, sha256- and signature-checked offline), with current Ghostty parsing and query replies; the Coder engine stays the default (superseded by the row below) | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 042](../adrs/042.client.official-vt-engine.md) | ✅ |
| Official engine only | Every tab runs Ghostty's official libghostty-vt wasm; the Coder engine, its wasm, `/ghostty-vt.wasm` and `?engine` are removed without a release on an official default, after ADR 042's acceptance record and a manual check in Chrome, Firefox and Safari. The `kitty.ts` size replies, the stream-scanned bell and title, `colorsSet` and the `scrollback`-derived history go with it; history is always `scrollbackLines`. Cursor style, mouse and paste encoders moved to the official APIs in ADR 049; theme colours from render state remain a follow-up | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 042](../adrs/042.client.official-vt-engine.md), [ADR 047](../adrs/047.client.official-engine-only.md) | ✅ |
| Scrollback in lines | Terminal history keeps the configured number of lines (`scrollbackLines`, default 10,000, a little under from page pruning) up to a 32 MiB ceiling, instead of a few hundred rows | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 046](../adrs/046.client.scrollback-lines.md) | ✅ |
| Mouse, cursor style and paste from libghostty-vt | Mouse reports (clicks, motion, drags past the edge, wheel ticks) are encoded by Ghostty's mouse encoder in every tracking mode and format, with Alt and buttons 8/9, at a device-pixel geometry that includes the padding; the cursor shape and blink come from Ghostty's state, with the config as its default; pastes go through `ghostty_terminal_paste` (bracketed whenever mode 2004 is on, control bytes stripped). X10-format reports past column 95 are dropped: they cannot travel as text frames | [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) |✅ |
| Selection from libghostty-vt | A double click selects Ghostty's word (URLs with queries, non-ASCII words, across a soft wrap), a triple click the whole logical line without its indent, and copied text is Ghostty's: soft-wrapped rows joined without a newline, trailing whitespace trimmed, wide characters whole. Drag, `copyOnSelect`, scrollback selection and the highlight are unchanged | [ADR 050](../adrs/050.client.selection-from-libghostty-vt.md) | ✅ |
| Scroll copies rows | A whole-line scroll copies the rows still in view with one canvas self-copy and draws only the rows that came into view; a frame with nothing changed, including one parked in scrollback, draws nothing; every partial frame equals a full redraw | [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Smooth scroll via overscan | Pixel-smooth scrollback draws 16 extra rows above and below the viewport (from the scrollback provider), when they come into view, and translates the canvas across them before copying rows, replacing ADR 040's strip canvas | [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 043](../adrs/043.client.scroll-copy-and-overscan.md) | ✅ |
| Smooth mouse wheel | A mouse wheel notch glides to its target over 125 ms (ease-out cubic), and notches during a glide add up; a sparse stream of pixel deltas (a TrackPoint) glides each delta linearly over the time it took to arrive, or follows a spring while the stream is fast, and in apps the scroll ticks of wheel notches and sparse deltas are paced over the same times instead of sent in a burst; a trackpad still scrolls immediately. VS Code's classifier tells the two apart by their recent deltas | [ADR 045](../adrs/045.client.smooth-mouse-wheel.md) | ✅ |
| ~~Glyph cache~~ | ~~Full repaints copy glyphs from an atlas canvas instead of calling `fillText` per cell~~: in Chrome it took about twice the script and GPU time of `fillText`, and `measureText` ink boxes were not exact enough | [ADR 044](../adrs/044.client.glyph-cache.md) | ❌ rejected |
| Mouse scroll | When the PTY app enables mouse tracking (e.g. vim `set mouse=a`), the terminal forwards wheel events as mouse buttons 4/5 at the pointer's cell, encoded by Ghostty in the app's format (`\x1b[<64/65;col;rowM` under SGR), instead of arrow keys, so apps scroll their buffer rather than move the cursor | [ADR 017](../adrs/017.client.mouse-scroll.md), [ADR 041](../adrs/041.client.libghostty-vt.md), [ADR 049](../adrs/049.client.official-mouse-cursor-paste.md) | ✅ |
| Keyboard bindings | Capture-phase `keydown` handler intercepts configured `key`+`mods` combos and sends `chars` to PTY; defaults to `[]` (no built-in bindings) | [ADR 018](../adrs/018.key-bindings.config-support.md) | ✅ |
| Canvas gap fill | After each fit, distribute the gap between the container and canvas as symmetric padding so the canvas is centred at the new size | [ADR 022](../adrs/022.client.canvas-fill.md) | ✅ |
| Font-size zoom | `Ctrl/Cmd` + `=`/`-`/`0` adjust terminal font size in-session; not configurable; same shortcuts as VS Code | [ADR 023](../adrs/023.client.font-size-zoom.md) | ✅ |
| Kitty graphics | Client intercepts kitty graphics APC sequences and draws images on an overlay canvas; enables terminal-browser and `icat`-style tools | [ADR 032](../adrs/032.client.kitty-graphics-overlay.md) | ✅ |
| Tighter fit | Grid sized by the vendored `FitAddon` from the full container, with no scrollbar reserve, shrinking the strip at the edges to under one cell; what is left over is handled by the padding and edge-extension rows below | [ADR 033](../adrs/033.client.padding-fit.md), [ADR 041](../adrs/041.client.libghostty-vt.md) | ✅ |
| Configurable padding | Top-level `padding` (px, default `0`) reserves space around the canvas on all sides; the grid is fitted to what remains; the top and left gap is exactly `padding` and the leftover goes to the right and bottom; optional `theme.padding` colours the space `padding` adds (default: `theme.background`) but not the leftover | [ADR 034](../adrs/034.client.padding-config.md) | ✅ |
| Edge extension | The leftover strip at the right and bottom takes the edge cells' own background, by repainting the canvas' last pixel row and column across it; always on, no setting | [ADR 035](../adrs/035.client.edge-extend.md) | ✅ |
| Theme key mapping | The config's `purple`, `brightPurple` and `selection` are translated to the terminal's `magenta`, `brightMagenta` and `selectionBackground`, which were previously ignored; `selectionForeground` is new and defaults to `background` when `selection` is set | [ADR 036](../adrs/036.client.theme-key-mapping.md) | ✅ |
