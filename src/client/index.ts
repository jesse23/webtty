import { OutputAck } from './ack';
import { Composer } from './compose';
import { EdgeExtender } from './edge';
import { computeInsets } from './fit';
import { KittyGraphics } from './graphics';
import { nonTextPaste } from './paste';
import { SmoothScroll } from './smooth-scroll';
import { toTerminalTheme } from './theme';
import { FitAddon, Ghostty, Terminal } from './vendor/ghostty-web';
import { watchDevicePixelRatio } from './vendor/ghostty-web/renderer';
import { WheelStream } from './wheel-stream';

interface KeyboardBinding {
  key: string;
  mods?: string[];
  chars: string;
}

interface Theme {
  background?: string;
  foreground?: string;
  cursor?: string;
  selection?: string;
  selectionForeground?: string;
  padding?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  purple?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightPurple?: string;
  brightCyan?: string;
  brightWhite?: string;
}

interface ClientConfig {
  cols: number;
  rows: number;
  fontSize: number;
  fontFamily: string;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorStyleBlink: boolean;
  scrollbackLines: number;
  theme: Theme;
  copyOnSelect: boolean;
  rightClickBehavior: 'contextMenu' | 'copyPaste' | 'paste' | 'none';
  mouseScrollSpeed: number;
  padding: number;
  keyboardBindings: KeyboardBinding[];
}

const sessionId = window.location.pathname.split('/s/')[1] ?? 'main';

const config: ClientConfig = await fetch('/api/config').then((r) => r.json());

document.title = `${sessionId} | webtty`;

// The vendored ghostty-web is bundled into /dist/client-browser.js, so its default
// wasm lookup (relative to its own module URL) would depend on where the bundle sits.
// Load the wasm from the path the server serves it at instead (ADR 041). It is
// Ghostty's official libghostty-vt wasm, the only engine (ADR 042, ADR 047).
const ghostty = await Ghostty.load('/ghostty-vt-small.wasm');

// Translate webtty's theme keys to ghostty-web's names and keep `padding`, a webtty
// setting and not a terminal colour, out of the theme it receives (ADR 036).
const terminalTheme = toTerminalTheme(config.theme ?? {});

const term = new Terminal({
  ghostty,
  cols: config.cols,
  rows: config.rows,
  cursorStyle: config.cursorStyle,
  cursorBlink: config.cursorStyleBlink,
  fontSize: config.fontSize,
  fontFamily: config.fontFamily,
  scrollbackLines: config.scrollbackLines,
  mouseScrollSpeed: config.mouseScrollSpeed,
  // The terminal copies a mouse selection on mouseup, once, only when this is on (ADR 011).
  // A drag the app takes, while it tracks the mouse and Shift is up, selects nothing.
  copyOnSelect: config.copyOnSelect,
  // What a right-click the app does not take does; the terminal handles every
  // contextmenu, and asks for a paste through onPasteRequest (ADR 051)
  rightClickBehavior: config.rightClickBehavior,
  theme: terminalTheme,
});

const container = document.getElementById('terminal') as HTMLElement;
// The canvas paints theme.background; the container shows only in the padding around
// it, so theme.padding (default: background) colours the space set by config.padding.
// The sub-cell leftover at the right and bottom is not coloured: EdgeExtender stretches
// the edge cells' own background into it (see edge.ts).
const paddingColor = config.theme?.padding ?? config.theme?.background;
if (paddingColor) {
  container.style.background = paddingColor;
}
await term.open(container);
// The strips copy the edges of the part of the canvas in view (ADR 043).
const edges = new EdgeExtender(container, config.padding, () => term.renderer?.visibleArea);
// IME / dictation composition shows at the cursor in the theme's colours, not as a
// stray line under the canvas. See ADR 038.
new Composer(term, container, terminalTheme);
// Pixel-smooth scrollback scrolling for trackpads. See ADR 040 and ADR 043.
const wheelStream = new WheelStream();
const smoothScroll = new SmoothScroll(term, wheelStream);

// FitAddon sizes the grid from the full container less its CSS padding, so the
// padding is set to config.padding on every side first (#terminal is border-box, so
// clientWidth/Height do not change). What is left over, plus config.padding on each
// side, is then distributed as padding: top and left are exactly config.padding, and
// the leftover goes to the right and bottom. proposeDimensions rather than
// FitAddon.fit(), which ignores calls for 50 ms after each resize. See ADR 033.
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
function fit(): void {
  container.style.padding = `${config.padding}px`;
  const grid = fitAddon.proposeDimensions();
  if (!grid) return;
  if (grid.cols !== term.cols || grid.rows !== term.rows) {
    term.resize(grid.cols, grid.rows);
  }
  // Every font zoom, font load and DPR change reaches fit(). A grid change has
  // already sent the new cell pixels with resize; this sends them when only the
  // pixels changed, for Ghostty's size reports (ADR 042).
  term.syncCellPixelSize();
  const canvas = container.querySelector('canvas:not([data-edge])') as HTMLElement | null;
  if (!canvas) return;
  const insets = computeInsets(
    Math.max(0, container.clientWidth - canvas.offsetWidth),
    Math.max(0, container.clientHeight - canvas.offsetHeight),
    config.padding,
  );
  container.style.paddingLeft = `${insets.left}px`;
  container.style.paddingRight = `${insets.right}px`;
  container.style.paddingTop = `${insets.top}px`;
  container.style.paddingBottom = `${insets.bottom}px`;
  edges.update();
  smoothScroll.update();
}

// Both ResizeObserver and window 'resize' can fire for the same physical event.
// Schedule through rAF so multiple signals coalesce into one fit per frame.
let pendingFitFrame: number | null = null;
function scheduleFit(): void {
  if (pendingFitFrame !== null) return;
  pendingFitFrame = window.requestAnimationFrame(() => {
    pendingFitFrame = null;
    fit();
  });
}

scheduleFit();
new ResizeObserver(() => scheduleFit()).observe(container, { box: 'border-box' });
// ResizeObserver misses monitor hot-plug and DPI changes because those resize
// the viewport without changing the container's layout box. window resize fires
// reliably for both, so use both observers together.
window.addEventListener('resize', scheduleFit);

// Chromium can still be loading config.fontFamily when ghostty-web's
// CanvasRenderer measures font metrics synchronously on open, so mouse-to-cell
// hit testing gets captured against the fallback font's glyph width instead of
// the real one — clicks land on the wrong cell until something happens to
// resize the terminal. Firefox blocks first layout on web font load and
// doesn't hit this race. Remeasure once the real font is confirmed ready;
// ghostty-web's render loop then notices the canvas-vs-metrics mismatch on
// its next frame and self-corrects with a forced full repaint. See ADR 031.
// The new cell size also changes how many cols and rows fit and where the padding
// and edge strips go, so run the fit again once the metrics have changed.
document.fonts.ready.then(() => {
  term.renderer?.remeasureFont();
  scheduleFit();
});

// Chromium can evict a hidden tab's canvas backing store to reclaim GPU
// memory; Firefox does not. ghostty-web's render loop only repaints
// WASM-dirty rows, so a cleared canvas can stay blank/partial after switching
// back to the tab until content happens to change. Force a full repaint on
// visibility restore. See ADR 031.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (term.renderer && term.wasmTerm) {
    term.renderer.render(term.wasmTerm, true, term.viewportY);
  }
});

// The renderer follows devicePixelRatio changes itself (whole ratio, ADR 039). The
// edge strips also draw at the ratio, and the window may not resize on a move to a
// display of different scale, so fit again on a change.
watchDevicePixelRatio(window, scheduleFit);

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws: WebSocket;

// Kitty graphics: the wasm32 libghostty-vt build leaves kitty graphics out and
// discards the protocol's APC sequences, so PTY output goes through this instead of
// term.write(). See ADR 032 and ADR 041.
const graphics = new KittyGraphics(term, container, (data: string) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
});

function connect(): void {
  // flow=1: this client acknowledges output as it parses it, so the server paces it
  // (ADR 048).
  const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}/pty?cols=${term.cols}&rows=${term.rows}&flow=1`;
  const socket = new WebSocket(wsUrl);
  ws = socket;
  const ack = new OutputAck((message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  });

  const DIM = '\x1b[2m',
    YELLOW = '\x1b[1;33m',
    ITALIC = '\x1b[3m',
    RESET = '\x1b[0m';
  const tag = `${DIM}[${RESET} ${YELLOW}webtty${RESET} ${DIM}]${RESET}`;
  const msg = (text: string): string => `\r\n${tag} ${DIM}${ITALIC}${text}${RESET}\r\n`;

  ws.onopen = () => {
    graphics.reset();
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    // term.write() parses synchronously, so the output has been parsed once feed()
    // returns: acknowledging it now lets a slow tab slow the server down.
    graphics.feed(event.data);
    ack.parsed(event.data.length);
    smoothScroll.onOutput();
  };

  ws.onclose = (event: CloseEvent) => {
    ack.dispose();
    if (event.code === 4003) {
      // The server dropped this tab for falling too far behind the output. Start
      // again from the replay, as a new tab would (ADR 048).
      term.reset();
      term.write(msg('Tab fell behind; replaying recent output.'));
      connect();
      return;
    }
    if (event.code === 4001) {
      term.write(msg('Session removed.'));
      setTimeout(() => window.close(), 500);
      return;
    }
    if (event.code === 1001) {
      term.write(msg('Server stopped.'));
      setTimeout(() => window.close(), 500);
      return;
    }
    term.write(msg('Connection lost. Reconnecting in 2s...'));
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    term.write(msg('WebSocket error.'));
  };
}

connect();

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
    if (binding.chars && ws.readyState === WebSocket.OPEN) {
      ws.send(binding.chars);
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
    fit();
  },
  { capture: true },
);

// Forward terminal keystrokes and input to the PTY over WebSocket.
term.onData((data: string) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
});

// Notify the server when the terminal is resized so the PTY dimensions stay in sync.
term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
});

// ghostty-web swallows Ctrl+V without sending \x16 to the PTY (unlike
// xterm.js), relying entirely on the browser 'paste' event. On macOS that
// event only fires for Cmd+V (the OS paste gesture) - Ctrl+V produces no
// event at all. See ADR 014.
function sendCtrlV(): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('\x16');
}

// Text goes through the terminal, which encodes it as Ghostty does: bracketed
// while mode 2004 is on, control bytes stripped, and without 2004 newlines sent
// as CR (they may act as Enter). Ctrl+V is not a text fallback (remote TUIs can
// interpret it as an image-paste shortcut). See ADR 037 and ADR 049.
function sendPaste(text: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const ctrlV = nonTextPaste(text);
  if (ctrlV) ws.send(ctrlV);
  else term.paste(text);
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

// Ctrl+V never reaches us as a 'paste' event on macOS (see above), so read
// the clipboard ourselves on keydown to make it behave like Cmd+V. Both
// listeners are on `container` and keydown targets it directly, so they run
// in registration order regardless of the capture flag - this one runs
// after the configured-binding listener above, so skip a combo the user has
// already bound (including an intentionally empty binding meant to consume
// the key and suppress default paste).
container.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.metaKey || e.code !== 'KeyV') return;
    if (findBinding(e)) return;
    if (!pasteFromClipboard()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  },
  { capture: true },
);

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
