import { browserEnv } from './app/browser-env';
import { loadClientConfig } from './app/client-config';
import type { ClientContext } from './app/client-context';
import { detectMac } from './app/platform';
import { toTerminalOptions } from './app/terminal-options';
import { toTerminalTheme } from './app/terminal-theme';
import { createOutputHandler } from './connection/output-pipeline';
import { PtyConnection } from './connection/pty-connection';
import { ReplayWindow } from './connection/replay-window';
import { installClipboard } from './features/clipboard/clipboard-feature';
import { Composer } from './features/compose/composer';
import { installFind } from './features/find/find-feature';
import { installFontZoom } from './features/keyboard/font-zoom-feature';
import { findBinding } from './features/keyboard/key-bindings';
import { shortcutFor } from './features/keyboard/shortcut-map';
import { KittyGraphics } from './features/kitty/graphics/kitty-graphics';
import { browserNotifications } from './features/notifications/browser-notifications';
import { installNotifications } from './features/notifications/notifications-feature';
import { installPaste } from './features/paste/paste-feature';
import { PasteService } from './features/paste/paste-service';
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

// Intercept configured key+mods combos before ghostty-web sees them and send
// the bound chars directly to the PTY. See ADR 018.
container.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    const binding = findBinding(e, config.keyboardBindings);
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

// Font zoom: the last window capture keydown listener, fitting at once (ADR 033).
installFontZoom(ctx, { fit: () => layout.fit() });

// Forward terminal keystrokes and input to the PTY over WebSocket.
term.onData((data: string) => connection.send(data));

// Notify the server when the terminal is resized so the PTY dimensions stay in sync.
term.onResize(({ cols, rows }: { cols: number; rows: number }) =>
  connection.sendResize(cols, rows),
);

// Pastes: text through the terminal, a non-text paste as Ctrl+V (ADR 014, ADR 037, ADR 049).
const paste = new PasteService(term, connection, env.navigator);

// Copy, paste, clear-screen, find and jump-to-prompt keys as Ghostty binds them for this
// platform (ADR 054, ADR 055, ADR 057).
// Ctrl+V never reaches us as a 'paste' event on macOS (ADR 014), so the clipboard is
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
    if (!shortcut || findBinding(e, config.keyboardBindings)) return;
    if (shortcut.action.startsWith('find')) {
      // Escape, closing and moving are the app's while the bar is closed (ADR 055)
      if (shortcut.action !== 'find' && !find.isOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (shortcut.action === 'find') find.open();
      else if (shortcut.action === 'findClose') find.close();
      else find.go(shortcut.action === 'findNext' ? 'next' : 'previous');
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
      if (paste.pasteFromClipboard()) e.preventDefault();
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

// Find in the scrollback (ADR 055); the shortcut listener above reads it only on a key.
const find = installFind(ctx, {
  ...env,
  shortcutActionOf: (e) => shortcutFor(e, mac)?.action,
});

// Cmd+K: nothing on the alternate screen; the clear is this tab's own, and a reload
// replays the session's output again (ADR 054)
function clearScreen(): boolean {
  if (!term.clearScreen()) return false;
  graphics.clear();
  smoothScroll.onOutput();
  return true;
}

// The right click set to paste, then the container capture paste listener (ADR 051).
installPaste(ctx, { paste });
