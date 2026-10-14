# SPEC: Architecture

**Last Updated:** 2026-10-14

---

## Description

How webtty's code is organised: the layers, the folders, what kind of module each file is, who may import whom, how big a file may grow, how files are named and commented, and how they are tested. The behaviour of each part is in its own SPEC ([webtty](webtty.md), [client](client.md), [cli](cli.md), [config](config.md), [kitty-graphics](kitty-graphics.md), [key-bindings](key-bindings.md)); this SPEC is the map that tells a reader where that behaviour lives in the code.

**Why a SPEC of its own, not a section of `webtty.md`?** `webtty.md` describes the product (sessions, the REST API, flow control). The code organisation is a repo-level concern that every module shares and every change has to follow, so it gets its own living SPEC, as [development.md](../development.md) asks for a repo-level concept.

The rules here are decided in [ADR 059](../adrs/059.architecture.code-organisation.md) (organisation and conventions), [ADR 060](../adrs/060.client.feature-modules.md) (the client composition root and feature modules), [ADR 061](../adrs/061.client.vendor-split.md) (splitting the vendored ghostty-web layer), [ADR 062](../adrs/062.server.composition.md) (server composition), [ADR 063](../adrs/063.cli.command-modules.md) (CLI command modules), [ADR 064](../adrs/064.architecture.test-strategy.md) (testing) and [ADR 065](../adrs/065.client.listener-teardown.md) (the listener teardown fix, the one deliberate behaviour change).

## Principles

1. **One file, one job, one name.** A file holds one class, one service, one group of pure functions on one subject, one constants table or one set of types, and is named after it.
2. **Folders name a domain, not a kind.** `connection/`, `layout/`, `sessions/`, `routes/`, `engine/`, `render/`. There is no `utils/`, `services/` or `models/` folder; a module's kind is in its header comment.
3. **Dependencies point one way** (below). Nothing imports a layer above it, and sibling features never import each other.
4. **The composition root shows the order.** Every place where order is behaviour (listener registration, install order, the per-message pipeline) is written once, as straight-line code with numbered comments, in the root that wires it: `src/client/app/start-client.ts`, `src/server/app.ts`, `src/cli/main.ts`.
5. **Globals come in through the constructor.** A class or service takes the browser or Node API it touches (`WebSocket`, timers, `requestAnimationFrame`, `document`, `navigator`, the clipboard, `fetch`, `spawn`) as a `deps` or `host` argument with a production default, so a test passes a fake.
6. **Hot paths stay direct calls.** No event bus, emitter fan-out, closure or allocation is added on: the WebSocket `onmessage` pipeline, the render loop, the per-cell decode and paint, the server's PTY `onData` and `OutputPacer`.
7. **Behaviour is frozen by a refactor.** Wire protocol, config keys, CLI output, HTTP routes and bodies, listener targets, phases and order stay byte-identical. A behaviour change is its own commit with its own ADR.
8. **No framework, no new runtime dependency.** Plain TypeScript classes and functions; one pinned devDependency (`happy-dom`, ADR 064) for DOM tests.

## Layers and dependency rules

```
src/cli ──────────────┐
src/server ──► src/pty│──► src/config (node) ──► (types only) ◄── src/client
        └──────► src/runtime.ts, src/version.ts, src/ndjson.ts (shared by server and CLI)

src/client:
  index.ts (entry)
    └► app/start-client.ts (composition root)
         └► features/*   ──► connection/, layout/, app/ (context, platform, client-config)
                                   └► vendor/ghostty-web  (the barrel index.ts only)
                                            └► vendor/ghostty-web/** internals ──► vendor/ghostty-vt (wasm, by URL)
```

| Rule | Checked by |
|---|---|
| `src/client/**` imports no `node:*` module and nothing from `src/server`, `src/cli` or `src/pty`. It may import **types only** from `src/config` (`import type`, erased from the bundle by `verbatimModuleSyntax`). | `scripts/check-architecture.ts` |
| `src/server`, `src/cli`, `src/pty`, `src/config` never import `src/client`. `src/cli` never imports `src/server` (it starts it as a process). | same |
| `src/client/vendor/ghostty-web/**` imports nothing outside itself. | same |
| App code (`src/client/**` outside `vendor/`) imports vendor code only through `vendor/ghostty-web` (the barrel), never a deep path. Tests may deep-import. | same |
| `src/client/features/<a>/**` never imports `src/client/features/<b>/**`. Features reach each other only through handles the composition root passes in. | same |
| Inside the vendored tree, the parts of a split facade (`engine/`, `core/`, `render/`, `input/`, `selection/`) import narrow interfaces (`engine/engine-types.ts`, `core/host-types.ts`, `render/renderable.ts`), never the facade class as a value, so no runtime import cycle can form. | review + `tsc` |
| A file under a `test-support/` folder is never named `*.test.ts`. | same |

**Contracts across the client/server line.** The config types are defined once, in `src/config`: the client derives `ClientConfig` from them (`Pick<Config, …>`) with `import type`, so the three copies of today (client type, server whitelist, server type) become one type and one key list (`CLIENT_CONFIG_KEYS`, server side) pinned by a test. Wire constants that the client needs as values (the WebSocket close codes 1001, 4001, 4003) are mirrored in `src/client/connection/close-codes.ts` and pinned to the server's by a contract test that imports both (tests may cross the line; code may not).

## Folder tree

The target tree. Files marked *(entry)* keep their path because `scripts/build.ts`, `package.json` and the tests name them; `dist/` names (`client-browser.js`, `client.css`, `client.html`, `server/index.js`, `cli/index.js`, `ghostty-vt-small.wasm`, `THIRD_PARTY_LICENSES`) never change.

```
src/
  version.ts                    util: package version lookup
  runtime.ts                    util: isBun, isWindows, bunTerminalAvailable, packageRunner (one definition per meaning)
  ndjson.ts                     object: LineSplitter (server /publish and CLI run)
  test-support/server-harness.ts  test util: getFreePort, waitForServer*, makeTmpHome (was src/utils.test.ts)
  config/                       node; server + cli; the client imports types only
    index.ts                    service: loadConfig, initConfig, re-exports the types (keeps `../config` imports working)
    config-schema.ts            types: Config, Theme, KeyboardBinding, RightClickBehavior, ClientConfig, CLIENT_CONFIG_KEYS
    config-paths.ts             util: configDir, getConfigPath
    defaults.ts                 constants: DEFAULT_THEME, DEFAULT_KEYBOARD_BINDINGS, DEFAULT_CONFIG
    parse-config.ts             util (pure): parseConfig(raw), parseRightClickBehavior
    keyboard-bindings.ts        util (pure): isValidBinding, normalizeBinding, mergeKeyboardBindings
    client-view.ts              util (pure): toClientConfig(config) over CLIENT_CONFIG_KEYS
  pty/
    index.ts                    facade: spawnPty(options), backend choice (keeps the 'pty: …' log line)
    pty-process.ts              types: PtyProcess, PtySpawnOptions (was types.ts)
    bun-backend.ts  node-backend.ts  node-pty.d.ts
  server/
    index.ts (entry)            main(): env and PORT, createServer, listen, signals
    app.ts                      factory: createServer({ loadConfig, store, spawnPty, paths, onStop }) → { httpServer, wss, shutdown }
    server-paths.ts             util: projectRoot, clientRoot, wasmPath (the one place that knows src vs dist depth)
    output-pacer.ts             object: OutputPacer, splitChunks, DEFAULT_FLOW_LIMITS (was flow.ts)
    http/
      router.ts                 util: ordered method + pattern table (declaration order = the old if-chain order)
      respond.ts                util: sendJson, sendText, CORS_HEADERS
      request-body.ts           util: readJson (64 KB) and its single 413/400 mapping, decodeId
      static-files.ts           service: mimeType, serveFile
    routes/
      route-table.ts            wiring: the ordered route list
      server-routes.ts  config-routes.ts  session-routes.ts  page-routes.ts  asset-routes.ts  publish-route.ts  execute-route.ts
      run-command.ts            service: child process → NDJSON (spawn injected)
    sessions/
      session-store.ts          object: SessionStore (map, lastUsedId, rename, remove, findByPid, onEmpty)
      session.ts                object: Session (PTY lifecycle, scrollback ring, close, broadcast)
      session-id.ts             util: ID_RE, isValidId, generateId
      session-banner.ts         util (pure): sessionBanner(runner)
    ws/
      close-codes.ts            constants: WS_CLOSE
      ws-upgrade.ts             wiring: noServer upgrade router
      pty-socket.ts             handler: a client socket attached to a Session
      events-socket.ts          handler: event subscribers
      client-message.ts         util (pure): parseClientMessage (keeps the startsWith('{') fast path), clampSize
  cli/
    index.ts (entry)            await main(process.argv)
    main.ts                     composition root: parse args, build deps, dispatch
    cli-args.ts  help-text.ts   util (pure)
    cli-deps.ts                 types + factory: CliDeps { client, out, err, exit, spawn, config }
    api-client.ts               service: WebttyClient(baseUrl, fetch)
    server-process.ts           service: resolveServerEntry (pure), startServer, stopServer
    browser-opener.ts           util: openBrowser, toBrowserHost
    commands/                   one file per command: go, list, remove, rename, start-stop, edit-config, run, key; key-format.ts
  client/
    index.ts (entry)            ~15 lines: await startClient(browserEnv())
    client.html  index.css      (paths fixed: copied by scripts/build.ts)
    app/
      start-client.ts           composition root: bootstrap, install features in the documented order, connect
      browser-env.ts            adapter: the real window, document, navigator, fetch, WebSocket, timers, rAF
      client-context.ts         types: ClientContext, Feature, Disposable
      client-config.ts          service + type: ClientConfig (from src/config types), loadClientConfig(fetch)
      terminal-options.ts       util (pure): toTerminalOptions(config, theme)
      terminal-theme.ts         util (pure): toTerminalTheme (was theme.ts)
      platform.ts               util: detectMac(navigator), isTerminalFocused(doc, container)
    connection/
      pty-connection.ts         service: PtyConnection (URL, connect, reconnect, send, sendResize, isOpen; WebSocket ctor and timers injected)
      close-codes.ts            constants: the close codes the client acts on (pinned to the server's)
      close-policy.ts           util (pure): closeActionFor(code)
      status-line.ts            util (pure): the "[ webtty ]" ANSI status line
      output-pipeline.ts        util: createOutputHandler(…) – the fixed per-message call order
      output-ack.ts             object: OutputAck (was ack.ts)
      replay-window.ts          object: ReplayWindow (was replay.ts)
    layout/
      fitter.ts                 service: Fitter { fit(), schedule(), onFitted } (rAF coalesced)
      fit-insets.ts             util (pure): computeInsets (was fit.ts)
      layout-feature.ts         feature: ResizeObserver, window resize, fonts.ready, DPR watch, padding colour
      repaint-on-visible.ts     feature: the Chromium canvas repaint on visibility (ADR 031)
      terminal-canvas.ts        constants + util: the canvas selectors (today's exact strings) and terminalCanvas()
      edge-rects.ts             util (pure): computeEdgeRects
      edge-extender.ts          view: EdgeExtender (+ dispose)
    features/
      tab-title/                tab-title.ts (object), tab-title-feature.ts
      notifications/            desktop-notifier.ts (object), browser-notifications.ts (adapter + activates), notifications-feature.ts
      clipboard/                clipboard-writer.ts (object, was clipboard-write.ts), clipboard-feature.ts
      paste/                    non-text-paste.ts (util), paste-service.ts (service), paste-feature.ts
      find/                     find-bar.ts (view), find-format.ts (util), find-keys.ts (util), find-feature.ts
      keyboard/                 key-bindings.ts, shortcut-map.ts (was shortcuts.ts), shortcut-commands.ts, font-zoom.ts, key-dispatcher.ts (feature), font-zoom-feature.ts
      compose/                  composer.ts (view + dispose), composer-geometry.ts (util)
      scroll/                   smooth-scroll.ts, scroll-split.ts, wheel-classifier.ts (VS Code MIT notice), wheel-stream.ts, scroll-feature.ts
      kitty/
        protocol/               apc-splitter.ts, apc-command.ts, chunk-assembler.ts, kitty-reply.ts, png-size.ts, cell-geometry.ts, control-scanner.ts
        graphics/               image-store.ts, image-decoder.ts, placements.ts, kitty-limits.ts, overlay-canvas.ts (+ dispose), kitty-graphics.ts (facade)
        kitty-feature.ts
    test-support/               fake-terminal.ts, fake-socket.ts, manual-clock.ts, recording-target.ts, dom-window.ts
    vendor/
      ghostty-vt/               untouched: official wasm, sidecar, signature, LICENSE, PROVENANCE.md
      tests/                    vendor tests, Biome-linted, mirroring ghostty-web/ (engine/, core/, render/, input/, selection/, links/)
        support/                wasm.ts (the one WASM path, a cached loadGhostty()), fake-canvas.ts, fake-event-target.ts
        fixtures/               PTY captures (was vendor/fixtures/)
      ghostty-web/              Biome-excluded; see "The vendored layer"
scripts/
  build.ts                      unchanged outputs
  check-architecture.ts         size and import rules (library) + check-architecture.test.ts
  update-ghostty-vt.ts          CLI only (--commit, --verify)
  ghostty-vt/                   minisign.ts, sidecar.ts, inspect-wasm.ts, release-fetch.ts (fetch injected)
```

### The vendored layer

`src/client/vendor/ghostty-web/` keeps its root, its `LICENSE`, `LICENSE.ghostty-vt-js`, `PROVENANCE.md` and `fn-table.ts`, so `scripts/build.ts` and the licence trail do not move. The five large files stay at their paths as slim **facades** (their public classes and re-exports), so the barrel, every deep import and `git blame` on the facade keep working; their parts move into subfolders (ADR 061):

```
ghostty-web/
  index.ts              public barrel: the only path app code imports (adds Glide, Pace, watchDevicePixelRatio, DisposableStore, listen)
  ghostty.ts            facade: Ghostty factory class + re-exports of engine types           (≤ 300)
  terminal.ts           facade: Terminal (xterm-compatible API, emitters, OpenedParts)      (≤ 600)
  renderer.ts           facade: CanvasRenderer orchestration                                (≤ 500)
  input-handler.ts      facade: InputHandler (options object)                               (≤ 300)
  selection-manager.ts  facade: SelectionManager state + API (SelectionHost)                (≤ 300)
  interfaces.ts  buffer.ts (IBufferSource)  event-emitter.ts  types.ts (re-export shim until removed)
  search.ts  glide.ts  wheel.ts  mouse-route.ts       webtty-original, kept in place
  link-detector.ts  providers/  addons/fit.ts  fn-table.ts
  lifecycle/            disposable-store.ts (DisposableStore, listen) – webtty-original
  engine/               every wasm call; no DOM
    engine-types.ts  cell-types.ts  wasm-exports.ts  vt-layout.ts  official-layout.ts  key-tables.ts  scratch.ts
    wasm-loader.ts  engine-context.ts  official-terminal.ts  render-state.ts  scrollback-pages.ts
    selection-binding.ts  search-binding.ts  mouse-encoder.ts  paste-focus-encoders.ts  engine-effects.ts
    cursor-blink.ts  text-mime.ts  key-encoder.ts
  core/                 Terminal's collaborators; import core/host-types.ts, never terminal.ts
    host-types.ts  terminal-constants.ts  terminal-geometry.ts  terminal-options.ts  dom-setup.ts
    viewport.ts  focus-tracker.ts  find-controller.ts  write-pipeline.ts  render-loop.ts
    mouse-controller.ts  wheel-controller.ts  scrollbar-controller.ts
  render/               renderable.ts  default-theme.ts  device-pixel-ratio.ts  frame-lines.ts  cell-range.ts  row-band.ts
                        font-metrics.ts  cell-painter.ts  row-repainter.ts  cursor-painter.ts  scrollbar-geometry.ts  scrollbar-painter.ts
  input/                key-types.ts  key-map.ts  key-encoding.ts  text-input.ts (EchoGuard)  mouse-report.ts
  selection/            selection-coords.ts  selection-gestures.ts  auto-scroll.ts  context-menu-textarea.ts  clipboard-copy.ts
```

The wasm stays at `vendor/ghostty-vt/`; `engine/wasm-loader.ts` resolves its default URL as `../../ghostty-vt/ghostty-vt-small.wasm`. The client always passes `/ghostty-vt-small.wasm` explicitly.

## Module kinds and patterns

Every file is one of these kinds, named in its header comment.

| Kind | What it is | Pattern | Example |
|---|---|---|---|
| **entry** | Process or bundle entry; no logic | calls the composition root | `src/client/index.ts`, `src/server/index.ts` |
| **composition root** | Builds the objects, wires them in the documented order, returns one disposer | explicit construction, no container | `app/start-client.ts`, `server/app.ts`, `cli/main.ts` |
| **feature** | Wires DOM and terminal events to objects; holds no logic beyond the wiring | `install<Name>(ctx, deps): <Name>Feature`, where `<Name>Feature extends Disposable` and adds the small API others need | `tab-title-feature.ts` |
| **service** | A class doing I/O through injected collaborators | constructor injection with production defaults | `PtyConnection`, `SessionStore`, `WebttyClient` |
| **object** | Pure state machine or value object | class, no I/O | `ReplayWindow`, `OutputAck`, `Glide` |
| **view** | A DOM widget; takes its `document` | builds its DOM in the constructor, `dispose()` removes it | `FindBar`, `Composer`, `EdgeExtender` |
| **util** | Pure functions on one subject | functions only | `close-policy.ts`, `fit-insets.ts` |
| **adapter** | Wraps one browser or Node API behind a narrow interface | function returning the interface | `browser-notifications.ts`, `browser-env.ts` |
| **constants** | Named values with their ADR | `const` exports | `close-codes.ts`, `terminal-constants.ts` |
| **types** | Interfaces and type aliases only | `export type` / `interface` | `client-context.ts`, `engine-types.ts` |
| **facade** | A public class that composes collaborators and keeps a stable API | delegation; collaborators created in one place | vendor `Terminal`, `OfficialTerminal`, `CanvasRenderer` |

Other patterns used, each in one named place: **Command map** for shortcut dispatch (`shortcut-commands.ts`), **Strategy** for link providers and the clipboard copy fallback chain (`clipboard-copy.ts`), **ordered route table** for HTTP (`route-table.ts`), **Disposable store** for listener and timer teardown (`lifecycle/disposable-store.ts`).

### Disposables

`listen(target, type, fn, options)` adds a listener and returns a `Disposable` that removes it with the same `capture` flag. `DisposableStore` collects disposables and disposes them once, in reverse order; disposing twice is a no-op. Every class that adds a listener, a timer, an interval or a `requestAnimationFrame` loop owns a store and releases it in `dispose()`.

### The client composition root

`startClient(env)` runs these steps, in this order, written once in the file with numbered comments and pinned by a test that installs everything on fakes and records each listener's target, type, phase and order:

1. Load the config (`/api/config`), `Ghostty.load('/ghostty-vt-small.wasm')`, `new Terminal(toTerminalOptions(…))`, colour the padding, `term.open(container)`.
2. Layout: Fitter, edge strips, DPR watch, `fonts.ready`, repaint on visibility.
3. Scroll: SmoothScroll, the wheel handler, wheel pace, `attachBeforeRender`.
4. Kitty graphics (the output writer).
5. Window capture listeners in today's order: clipboard arming, tab title and notifier (user input, attended), then font zoom (a window listener so it works without focus).
6. The key dispatcher: **one** container capture `keydown` listener. A configured binding wins (`preventDefault`, `stopPropagation`, send its chars, return); otherwise Ghostty's shortcuts run with today's `stopImmediatePropagation` and `performable` rules. It is registered after `term.open`, so it runs before the InputHandler.
7. Paste: `onPasteRequest` and the container capture `paste` listener.
8. The find bar.
9. The connection: `clipboard.connected()` and `replay.connected()` run synchronously when the socket is created; on open, `graphics.reset()`, the resize message, `resyncFocus()`.

Features get what they need from `ClientContext` (`term`, `container`, `config`, `terminalTheme`, `mac`, `doc`, `win`) and from handles the root passes explicitly (the connection, the fitter, the find bar, `clearScreen`). There is no service locator and no event bus.

**The per-message pipeline** is a direct call sequence, with no allocation: `replay.output(len, now)` → `graphics.feed(data)` (which writes to the terminal) → `replay.parsed(now)` → `ack.parsed(len)` (after the parse, ADR 048) → `smoothScroll.onOutput()`.

### The server composition root

`createServer(deps)` builds the HTTP server and the WebSocket server around one `SessionStore`, an injected `loadConfig` (still called per request and per spawn, so editing the config file takes effect on the next tab reload, ADR 009) and an injected `spawnPty`. Routes are an ordered table evaluated in the old if-chain's order; CORS headers are on every response, 404s included.

## Size limits

Counted in lines, comments and blank lines included. Checked by `scripts/check-architecture.ts` under `bun test`.

| Files | Aim | Hard limit |
|---|---|---|
| App, server, CLI, config, pty, scripts source | ≤ 200 | 300 |
| Vendored ghostty-web source | ≤ 400 | 600 (facade limits in the tree above) |
| `engine/render-state.ts` (the per-cell decode hot path, kept as one unit) | — | 700 |
| Data tables: `input/key-map.ts`, `input/key-types.ts` (the `Key` enum), `engine/official-layout.ts` | — | exempt, listed with the reason |
| Test files | ≤ 600 | 800 |
| Functions | ≤ 60 lines | not checked; hot paths (`decodeRow`, `render`) say why when longer |

While the refactor runs, the checker carries a **ratchet allowlist**: each file over its limit today, with its current line count. A listed file may shrink or disappear, never grow; each step removes the entries it fixes, and the list is empty at the end.

## Naming

- **Files** are kebab-case and named after their main export: `class OutputAck` → `output-ack.ts`, `findBinding` → `key-bindings.ts`. Classes and services are nouns (`SessionStore`); pure helper files are named for their subject (`close-policy.ts`, `fit-insets.ts`).
- **Feature installers** are `<name>-feature.ts` exporting `install<Name>`.
- **Narrow collaborator interfaces** are `<Thing>Host` (what an object needs from its owner) or `<Thing>Source` (what it reads).
- **Constants** sit at the top of the one module that uses them; a `*-constants.ts` file exists only when several modules share them.
- **Banned:** `utils.ts`, `helpers.ts`, `misc.ts`, `common/`, and a bare `types.ts` at a folder root (the vendor `types.ts` is a temporary re-export shim). `index.ts` is only an entry or the vendor barrel.
- **Basenames are unique** within `src/client` and within `src/server` where practical, so editor tabs and stack traces read without the path.

## Comments

- **File header:** one to three plain sentences: what the module is, its kind, and the ADRs behind it. Example: `// Sends ack messages as output is parsed, so the server paces a slow tab (object, ADR 048).`
- **Vendored files derived from Coder's code** start with: `// Derived from coder/ghostty-web lib/<original>.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).` **webtty-original vendored files** start with `// webtty (ADR NNN), not from upstream.`
- **`(webtty, ADR NNN)` tags** move with the lines they describe.
- **Every export** has a JSDoc line saying what it is for, not restating its signature.
- **Inline comments** say why, in the repo's plain style with ADR references. No section banners (`// ---- Private ----`), no comments restating the code. Stale upstream text is fixed as files are touched (`@cmux/ghostty-terminal`, `Phase 2`, `Ghostty.load()` without a path).

## Testing

- **Placement.** A test sits next to its module as `x.test.ts`. Vendor tests live in `src/client/vendor/tests/`, mirroring `ghostty-web/` (the vendored tree is Biome-excluded, its tests are not). Shared fakes live in `test-support/` folders.
- **Pure modules:** table-driven tests, 100% lines.
- **Objects and services:** tested through their public API with fakes from `test-support/` (`FakeSocket`, `ManualClock` for timers and rAF, `FakeTerminal`, `RecordingTarget` for listeners).
- **Views and features:** `happy-dom` (pinned devDependency), used as an explicit `new Window()` whose `document` is injected; never registered globally, so tests that stub globals are not disturbed (ADR 064).
- **Teardown:** every `dispose()` has a test that it removes each listener, timer and frame it added, and that a second `dispose()` does nothing.
- **Order:** the client root has an install-order test; the per-message pipeline and the on-open sequence have call-order tests; the key dispatcher has a case-by-case equivalence test against the old two-listener behaviour.
- **Server:** routes, WebSocket channels and sessions run in-process through `createServer()` on port 0 with a temporary `HOME`, so they count in coverage. A few subprocess tests remain as end-to-end checks of the entries. No test may fall back to the configured port.
- **Vendor:** one cached `loadGhostty()` (`vendor/tests/support/wasm.ts`) so new test files do not each compile the wasm. New tests do not reach private members through `as unknown as {…}` casts; they test the collaborator that now owns the state.
- **Coverage targets** (`bun run test:coverage`, thresholds in `bunfig.toml` at the end of the refactor): app, server, CLI, config and pty ≥ 95% lines and ≥ 90% functions; vendored layer ≥ 85% lines and ≥ 80% functions; pure modules 100%.

## Features

| Feature | Description | ADR | Done? |
|---|---|---|---|
| Architecture SPEC and conventions | Layers, folders, module kinds, naming, size limits, comments | [ADR 059](../adrs/059.architecture.code-organisation.md) | ✅ |
| Architecture checker | `scripts/check-architecture.ts`: size limits with a ratchet, import rules | [ADR 059](../adrs/059.architecture.code-organisation.md) | ⬜ |
| Client composition root and feature modules | `start-client.ts`, `install(ctx, deps)`, PtyConnection, one key dispatcher, `index.ts` an entry only | [ADR 060](../adrs/060.client.feature-modules.md) | ⬜ |
| Kitty graphics split | `kitty.ts` and `graphics.ts` split into `features/kitty/protocol` and `graphics` | [ADR 060](../adrs/060.client.feature-modules.md) | ⬜ |
| Vendored engine split | `ghostty.ts` into `engine/`, `OfficialTerminal` a facade | [ADR 061](../adrs/061.client.vendor-split.md) | ⬜ |
| Vendored terminal, renderer, input and selection split | facades at their paths, parts in `core/`, `render/`, `input/`, `selection/` | [ADR 061](../adrs/061.client.vendor-split.md) | ⬜ |
| Listener teardown | `Terminal.dispose` and `SelectionManager` release every listener | [ADR 065](../adrs/065.client.listener-teardown.md) | ⬜ |
| Server composition | `createServer`, SessionStore, route table, `ws/` and `sessions/`, config split | [ADR 062](../adrs/062.server.composition.md) | ⬜ |
| CLI command modules | `main.ts`, WebttyClient, one file per command with injected deps | [ADR 063](../adrs/063.cli.command-modules.md) | ⬜ |
| Test strategy | test-support fakes, injected happy-dom, in-process server tests, vendor test mirror, coverage thresholds | [ADR 064](../adrs/064.architecture.test-strategy.md) | ⬜ |
