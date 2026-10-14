import { browserEnv } from './app/browser-env';
import { type KeyboardBinding, loadClientConfig } from './app/client-config';
import type { ClientContext } from './app/client-context';
import { detectMac } from './app/platform';
import { toTerminalOptions } from './app/terminal-options';
import { toTerminalTheme } from './app/terminal-theme';
import { createOutputHandler } from './connection/output-pipeline';
import { PtyConnection } from './connection/pty-connection';
import { ReplayWindow } from './connection/replay-window';
import { installClipboard } from './features/clipboard/clipboard-feature';
import { Composer } from './features/compose/composer';
import { FindBar } from './features/find/find-bar';
import { shortcutFor } from './features/keyboard/shortcut-map';
import { KittyGraphics } from './features/kitty/graphics/kitty-graphics';
import { browserNotifications } from './features/notifications/browser-notifications';
import { installNotifications } from './features/notifications/notifications-feature';
import { nonTextPaste } from './features/paste/non-text-paste';
import { SmoothScroll } from './features/scroll/smooth-scroll';
import { WheelStream } from './features/scroll/wheel-stream';
import { TabTitle } from './features/tab-title/tab-title';
import { installTabTitle } from './features/tab-title/tab-title-feature';
import { EdgeExtender } from './layout/edge-extender';
import { applyPaddingColor, installLayout } from './layout/layout-feature';
import { installRepaintOnVisible } from './layout/repaint-on-visible';

const sessionId = window.location.pathname.split('/s/')[1] ?? 'main';

const env = browserEnv();

const config = await loadClientConfig(env.fetch);

// Whether the output being parsed is the replay sent on connect (ADR 053)
const replay = new ReplayWindow();

// `<title> | webtty` from the program's OSC 0/2 title, or the session id, with a 🔔
// after a bell until the terminal is attended; replayed bells are ignored (ADR 053).
const tabTitle = new TabTitle(sessionId, config.bellTitle, replay, (title) => {
  document.title = title;
});

// The vendored ghostty-web is bundled into /dist/client-browser.js, so its default
// wasm lookup (relative to its own module URL) would depend on where the bundle sits.
// Load the wasm from the path the server serves it at instead (ADR 041). It is
// Ghostty's official libghostty-vt wasm, the only engine (ADR 042, ADR 047).
const ghostty = await env.loadEngine('/ghostty-vt-small.wasm');

// Translate webtty's theme keys to ghostty-web's names and keep `padding`, a webtty
// setting and not a terminal colour, out of the theme it receives (ADR 036).
const terminalTheme = toTerminalTheme(config.theme ?? {});

const term = env.createTerminal(toTerminalOptions(config, terminalTheme, ghostty));

const container = document.getElementById('terminal') as HTMLElement;
applyPaddingColor(container, config);
await term.open(container);

const ctx: ClientContext = {
  term,
  container,
  config,
  terminalTheme,
  mac: detectMac(env.navigator),
  doc: env.document,
  win: env.window,
};

// The strips copy the edges of the part of the canvas in view (ADR 043).
const edges = new EdgeExtender(container, config.padding, () => term.renderer?.visibleArea);
// IME / dictation composition shows at the cursor in the theme's colours, not as a
// stray line under the canvas. See ADR 038.
new Composer(term, container, terminalTheme);
// Pixel-smooth scrollback scrolling for trackpads. See ADR 040 and ADR 043.
const wheelStream = new WheelStream();
const smoothScroll = new SmoothScroll(term, wheelStream);

// The fit, its first run, and the resize, font and pixel ratio signals that refit (ADR 033)
const layout = installLayout(ctx, { ...env, edges, smoothScroll });
// The document listener is the first of the SPEC's visibilitychange listeners; the
// layout's own are on other targets, so their relative order does not matter.
installRepaintOnVisible(ctx);

// Created with the connection below; read only when a reply is sent.
let connection: PtyConnection;

// Kitty graphics: the wasm32 libghostty-vt build leaves kitty graphics out and
// discards the protocol's APC sequences, so PTY output goes through this instead of
// term.write(). See ADR 032 and ADR 041.
const graphics = new KittyGraphics(term, container, (data: string) => connection.send(data));

// A program's OSC 52 clipboard write, decoded by Ghostty, written to the browser
// clipboard once the user has used this tab since connecting (ADR 052).
const clipboard = installClipboard(ctx, { clipboard: env.navigator.clipboard });

// The title and the bell mark (ADR 053).
installTabTitle(ctx, { tabTitle });

// Desktop notifications (OSC 9, OSC 777), shown while the terminal is not focused, as
// Ghostty on macOS does; the bell mark without permission (ADR 056).
installNotifications(ctx, {
  sessionId,
  replay,
  title: tabTitle,
  notifications: browserNotifications(env.Notification),
  userActivation: env.navigator.userActivation,
  now: () => env.performance.now(),
});

// The PTY socket (ADR 048, ADR 060). PtyConnection owns the URL, the reconnects and the
// close codes; this says what runs around them.
connection = new PtyConnection(
  sessionId,
  {
    size: () => ({ cols: term.cols, rows: term.rows }),
    created: () => {
      // The output starts with the session's replay: hold OSC 52 writes until input (ADR 052)
      clipboard.connected();
      // ... and ignore its bells and notifications until the replay's last piece (ADR 053,
      // ADR 056)
      replay.connected();
    },
    opening: () => graphics.reset(),
    // Focus changes while the socket was down were dropped: send the state the app's
    // mode 1004 now misses (ADR 053). After a reset the mode is off until the replay.
    opened: () => term.resyncFocus(),
    output: createOutputHandler({
      replay,
      graphics,
      smoothScroll,
      now: () => env.performance.now(),
    }),
    write: (data) => term.write(data),
    reset: () => term.reset(),
    closeWindow: () => env.window.close(),
  },
  { ...env, location: env.window.location },
);
connection.connect();

// Wheel scrolling (ADR 017, ADR 040, ADR 045). WheelStream tells a mouse wheel, a
// trackpad and a TrackPoint apart and picks how each event moves:
// - on the normal screen, unless the app tracks the mouse, SmoothScroll glides the
//   scrollback pixel by pixel, advanced just before each render;
// - otherwise the terminal sends the app mouse wheel reports in the app's mouse format
//   (ADR 049), or arrow keys on the alternate screen, paced the same way.
term.attachCustomWheelEventHandler(
  (e: WheelEvent): boolean => !term.hasMouseTracking() && smoothScroll.handleWheel(e),
);
term.attachWheelPace((e: WheelEvent) => wheelStream.forApp(e));
term.attachBeforeRender((now: number) => smoothScroll.frame(now));

// Shared by the configured-binding listener below and the Ctrl+V paste
// listener further down, so the latter can tell whether a user has already
// claimed the combo (including an intentional no-op binding meant to
// suppress default behavior) before adding its own handling on top.
function findBinding(e: KeyboardEvent): KeyboardBinding | undefined {
  const key = e.key.toLowerCase();
  const active = new Set([
    ...(e.shiftKey ? ['shift'] : []),
    ...(e.ctrlKey ? ['ctrl'] : []),
    ...(e.altKey ? ['alt'] : []),
    ...(e.metaKey ? ['meta'] : []),
  ]);
  return config.keyboardBindings.find((b) => {
    if (b.key.toLowerCase() !== key) return false;
    const required = new Set((Array.isArray(b.mods) ? b.mods : []).map((m) => m.toLowerCase()));
    if (required.size !== active.size) return false;
    for (const m of required) if (!active.has(m)) return false;
    return true;
  });
}

// Intercept configured key+mods combos before ghostty-web sees them and send
// the bound chars directly to the PTY. See ADR 018.
container.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    const binding = findBinding(e);
    if (!binding) return;
    e.preventDefault();
    e.stopPropagation();
    if (binding.chars && connection.isOpen()) {
      // A keystroke scrolls to the bottom, as the terminal's own keys do (ADR 055)
      term.scrollToBottom();
      connection.send(binding.chars);
    }
  },
  { capture: true },
);

// Intercept Ctrl/Cmd +/- to resize the font without Shift, matching VS Code.
// Uses window so it fires regardless of focus, and preventDefault stops the
// browser's own page-zoom from triggering at the same time. stopPropagation
// prevents ghostty-web from forwarding the key as literal PTY input.
// e.code is used for physical key identity, independent of keyboard layout.
// currentFontSize is clamped to [6, 32] on init so a config value outside
// that range never inverts the zoom direction on the first keypress.
let currentFontSize = Math.min(32, Math.max(6, config.fontSize));
window.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const zoomIn = e.code === 'Equal' || e.code === 'NumpadAdd';
    const zoomOut = (e.code === 'Minus' && !e.shiftKey) || e.code === 'NumpadSubtract';
    const zoomReset = (e.code === 'Digit0' && !e.shiftKey) || e.code === 'Numpad0';
    if (!zoomIn && !zoomOut && !zoomReset) return;
    e.preventDefault();
    e.stopPropagation();
    if (zoomIn) currentFontSize = Math.min(32, currentFontSize + 1);
    else if (zoomOut) currentFontSize = Math.max(6, currentFontSize - 1);
    else currentFontSize = Math.min(32, Math.max(6, config.fontSize));
    term.options.fontSize = currentFontSize;
    layout.fit();
  },
  { capture: true },
);

// Forward terminal keystrokes and input to the PTY over WebSocket.
term.onData((data: string) => connection.send(data));

// Notify the server when the terminal is resized so the PTY dimensions stay in sync.
term.onResize(({ cols, rows }: { cols: number; rows: number }) =>
  connection.sendResize(cols, rows),
);

// ghostty-web swallows Ctrl+V without sending \x16 to the PTY (unlike
// xterm.js), relying entirely on the browser 'paste' event. On macOS that
// event only fires for Cmd+V (the OS paste gesture) - Ctrl+V produces no
// event at all. See ADR 014.
function sendCtrlV(): void {
  if (!connection.isOpen()) return;
  term.scrollToBottom();
  connection.send('\x16');
}

// Text goes through the terminal, which encodes it as Ghostty does: bracketed
// while mode 2004 is on, control bytes stripped, and without 2004 newlines sent
// as CR (they may act as Enter). Ctrl+V is not a text fallback (remote TUIs can
// interpret it as an image-paste shortcut). See ADR 037 and ADR 049.
function sendPaste(text: string): void {
  if (!connection.isOpen()) return;
  const ctrlV = nonTextPaste(text);
  if (ctrlV) {
    term.scrollToBottom();
    connection.send(ctrlV);
  } else term.paste(text);
}

// Reads the clipboard and pastes it, as Cmd+V does; a failed read sends Ctrl+V.
// Returns false when the browser cannot read the clipboard.
function pasteFromClipboard(): boolean {
  if (!navigator.clipboard?.readText) return false;
  navigator.clipboard.readText().then(sendPaste, sendCtrlV);
  return true;
}

// rightClickBehavior "paste" (ADR 051)
term.onPasteRequest(() => {
  pasteFromClipboard();
});

// Copy, paste, clear-screen, find and jump-to-prompt keys as Ghostty binds them for this
// platform (ADR 054, ADR 055, ADR 057).
// Ctrl+V never reaches us as a 'paste' event on macOS (see above), so the clipboard is
// read on keydown to make it behave like Cmd+V. Both keydown listeners are capture
// listeners on `container`, so they run in registration order - this one runs after the
// configured-binding listener above, so skip a combo the user has already bound
// (including an intentionally empty binding meant to consume the key and suppress the
// default). Both run before the input handler, which listens on the container too.
const { mac } = ctx;
container.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    const shortcut = shortcutFor(e, mac);
    if (!shortcut || findBinding(e)) return;
    if (shortcut.action.startsWith('find')) {
      // Escape, closing and moving are the app's while the bar is closed (ADR 055)
      if (shortcut.action !== 'find' && !findBar.isOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (shortcut.action === 'find') findBar.open();
      else if (shortcut.action === 'findClose') findBar.close();
      else findBar.go(shortcut.action === 'findNext' ? 'next' : 'previous');
      return;
    }
    if (shortcut.action === 'promptPrevious' || shortcut.action === 'promptNext') {
      // Ghostty's jump_to_prompt is consumed with or without a prompt to go to (ADR 057)
      term.jumpToPrompt(shortcut.action === 'promptPrevious' ? -1 : 1);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (shortcut.action === 'paste') {
      // Without the clipboard API the browser's own paste may still fire 'paste'
      if (pasteFromClipboard()) e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const done = shortcut.action === 'copy' ? term.copySelection() : clearScreen();
    // Not done and performable: the input handler sends the key to the app, as Ghostty does
    if (!done && shortcut.performable) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  { capture: true },
);

// Find in the scrollback with libghostty-vt's search (ADR 055). The bar is outside the
// container: its keys are its own. Closing it ends the search and refocuses the terminal.
const findBar = new FindBar(document.body, terminalTheme, (e) => shortcutFor(e, mac)?.action, {
  find: (needle) => term.find(needle),
  next: () => term.findNext(),
  previous: () => term.findPrevious(),
  close: () => {
    term.endFind();
    term.focus();
  },
});
term.onFindChange((state) => findBar.update(state));

// Cmd+K: nothing on the alternate screen; the clear is this tab's own, and a reload
// replays the session's output again (ADR 054)
function clearScreen(): boolean {
  if (!term.clearScreen()) return false;
  graphics.clear();
  smoothScroll.onOutput();
  return true;
}

container.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    const cd = e.clipboardData;
    if (!cd) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendPaste(cd.getData('text/plain'));
  },
  { capture: true },
);
