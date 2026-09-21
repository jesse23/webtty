import { init, Terminal } from 'ghostty-web';
import { applyDecscusr } from './cursor';
import { EdgeExtender } from './edge';
import { computeGrid, computeInsets } from './fit';
import { KittyGraphics } from './graphics';
import { isDuplicateDrag, rewriteHoverMotion } from './mouse';

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
  scrollback: number;
  theme: Theme;
  copyOnSelect: boolean;
  rightClickBehavior: 'default' | 'copyPaste';
  mouseScrollSpeed: number;
  padding: number;
  keyboardBindings: KeyboardBinding[];
}

const sessionId = window.location.pathname.split('/s/')[1] ?? 'main';

const config: ClientConfig = await fetch('/api/config').then((r) => r.json());

document.title = `${sessionId} | webtty`;

await init();

// `padding` is a webtty setting, not a terminal colour: keep it out of the theme
// handed to ghostty-web.
const { padding: _padding, ...terminalTheme } = config.theme ?? {};

const term = new Terminal({
  cols: config.cols,
  rows: config.rows,
  cursorStyle: config.cursorStyle,
  cursorBlink: config.cursorStyleBlink,
  fontSize: config.fontSize,
  fontFamily: config.fontFamily,
  scrollback: Math.ceil(config.scrollback / 80),
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
const edges = new EdgeExtender(container, config.padding);

// ghostty-web's FitAddon subtracts a fixed 15px scrollbar reserve, which leaves a
// strip at the edges even though the scrollbar is an overlay drawn inside the canvas.
// Size the grid from the full container instead (computeGrid), then distribute what is
// left, plus config.padding on each side, as padding: top and left are exactly
// config.padding, and the leftover goes to the right and bottom. Padding is cleared
// first so clientWidth/Height measure the whole container. See ADR 033.
function fit(): void {
  container.style.padding = '0';
  const metrics = term.renderer?.getMetrics();
  if (!metrics) return;
  const grid = computeGrid(
    container.clientWidth,
    container.clientHeight,
    metrics.width,
    metrics.height,
    config.padding,
  );
  if (!grid) return;
  if (grid.cols !== term.cols || grid.rows !== term.rows) {
    term.resize(grid.cols, grid.rows);
  }
  const canvas = container.querySelector('canvas') as HTMLElement | null;
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
document.fonts.ready.then(() => term.renderer?.remeasureFont());

// Chromium can evict a hidden tab's canvas backing store to reclaim GPU
// memory; Firefox does not. ghostty-web's render loop only repaints
// WASM-dirty rows, so a cleared canvas can stay blank/partial after switching
// back to the tab until content happens to change. Force a full repaint on
// visibility restore. See ADR 031 and ADR 015 for the same forced-repaint
// pattern used for the DECSCUSR ghost-cursor fix.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (term.renderer && term.wasmTerm) {
    term.renderer.render(term.wasmTerm, true, term.viewportY);
  }
});

// ghostty-web sets the mouse cursor to 'text' (I-beam) whenever the pointer
// isn't over a detected hyperlink — it only ever writes 'text' or 'pointer'
// (see the hover-link logic in ghostty-web's dist bundle). The I-beam reads
// as "editable text" even over TUI menus/widgets, which is misleading, so
// rewrite it to the platform default arrow while leaving the hyperlink
// 'pointer' cursor untouched.
function normalizeCursor(el: HTMLElement): void {
  if (el.style.cursor === 'text') el.style.cursor = 'default';
}
normalizeCursor(container);
new MutationObserver((mutations) => {
  for (const m of mutations) normalizeCursor(m.target as HTMLElement);
}).observe(container, { attributes: true, attributeFilter: ['style'], subtree: true });

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws: WebSocket;

// Kitty graphics: ghostty-web's WASM discards the protocol's APC sequences, so
// PTY output goes through this instead of term.write(). See ADR 032.
const graphics = new KittyGraphics(term, container, (data: string) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
});

function connect(): void {
  const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}/pty?cols=${term.cols}&rows=${term.rows}`;
  ws = new WebSocket(wsUrl);

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
    applyDecscusr(term, event.data);
    graphics.feed(event.data);
  };

  ws.onclose = (event: CloseEvent) => {
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

// ghostty-web's Terminal.handleWheel sends \x1b[A/\x1b[B (arrow keys) on the
// alternate screen regardless of mouse tracking state, moving the cursor instead
// of scrolling. When the PTY application has enabled mouse tracking (e.g. vim
// with `set mouse=a`), intercept wheel events and send the correct SGR mouse
// scroll sequence so the app receives a scroll event, not a cursor move.
// SGR button 64 = scroll up, 65 = scroll down. See ADR 017.
//
// config.mouseScrollSpeed scales SGR events per wheel tick (default 1).
// Values < 1 reduce rate via accumulation; values > 1 send multiple SGRs.
// The accumulator resets on direction change to prevent cross-direction bleed.
let scrollAccum = 0;
let scrollDir = 0;
term.attachCustomWheelEventHandler((e: WheelEvent): boolean => {
  if (!term.hasMouseTracking()) return false;
  const metrics = term.renderer?.getMetrics();
  if (!metrics) return false;
  const dir = e.deltaY < 0 ? -1 : 1;
  if (dir !== scrollDir) {
    scrollAccum = 0;
    scrollDir = dir;
  }
  scrollAccum += config.mouseScrollSpeed;
  const ticks = Math.trunc(scrollAccum);
  if (ticks === 0) return true;
  scrollAccum -= ticks;
  const rect = (e.target as HTMLElement).getBoundingClientRect();
  const col = Math.max(1, Math.floor((e.clientX - rect.left) / metrics.width) + 1);
  const row = Math.max(1, Math.floor((e.clientY - rect.top) / metrics.height) + 1);
  const btn = dir < 0 ? 64 : 65;
  const seq = `\x1b[<${btn};${col};${row}M`;
  if (ws && ws.readyState === WebSocket.OPEN) {
    for (let i = 0; i < ticks; i++) ws.send(seq);
  }
  return true;
});

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
// See src/client/mouse.ts for the ghostty-web SGR bug and the two fixes
// (hover rewrite + drag dedup) applied below.
let isHoverMove = false;
let lastDragSeq = '';
container.addEventListener(
  'mousemove',
  (e: MouseEvent) => {
    isHoverMove = term.hasMouseTracking() && e.buttons === 0;
    if (isHoverMove) lastDragSeq = ''; // reset dedup on button release
  },
  { capture: true },
);
term.onData((data: string) => {
  const seq = rewriteHoverMotion(data, isHoverMove);
  if (seq !== data) {
    // Hover: forwarded with corrected Cb=35 (no-button motion per SGR spec)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(seq);
    return;
  }
  if (isDuplicateDrag(data, lastDragSeq)) return; // drop same-cell drag repeat
  lastDragSeq = data.startsWith('\x1b[<32;') ? data : ''; // track or reset
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

// Copy the selected text to the clipboard whenever the selection changes.
if (config.copyOnSelect) {
  term.onSelectionChange(() => {
    const selection = term.getSelection() as string;
    if (!selection) return;
    navigator.clipboard.writeText(selection).catch(() => {
      /* empty */
    });
  });
}

// Copy selected text to clipboard on right-click when copyPaste mode is active.
if (config.rightClickBehavior === 'copyPaste') {
  container.addEventListener('contextmenu', (e: MouseEvent) => {
    const selection = term.getSelection() as string;
    if (!selection) return;
    e.preventDefault();
    navigator.clipboard.writeText(selection).catch(() => {
      /* empty */
    });
    term.clearSelection();
  });
}

// ghostty-web swallows Ctrl+V without sending \x16 to the PTY (unlike
// xterm.js), relying entirely on the browser 'paste' event. On macOS that
// event only fires for Cmd+V (the OS paste gesture) - Ctrl+V produces no
// event at all. See ADR 014.
function sendCtrlV(): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('\x16');
}

// A pasted newline is the only thing that can be misread as literal Enter
// by the receiving program, so a single-line paste is always safe to send
// as-is - e.g. a password into a sudo/ssh/mysql prompt, none of which
// request bracketed paste for themselves. Only a multi-line paste needs
// bracketed-paste mode (2004) to land as literal text: Vim keeps that mode
// on while editing normally (confirmed: plain-buffer paste works), but
// doesn't propagate it out while focus is in a nested :terminal job - e.g.
// an fzf popup running under `<leader>ff`. When it's off, don't guess by
// sending raw multi-line text: an embedded newline would be read as literal
// Enter (fzf reads that as "accept," closing the popup instead of receiving
// the paste). Fall back to \x16 instead and let the app fetch the clipboard
// itself - e.g. Vim's `tnoremap <C-v> <C-w>"+` terminal-mode mapping.
function sendPaste(text: string): void {
  if (!text) {
    sendCtrlV();
    return;
  }
  if (!text.includes('\n')) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
    return;
  }
  if (!term.getMode(2004)) {
    sendCtrlV();
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(`\x1b[200~${text}\x1b[201~`);
  }
}

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
    if (!navigator.clipboard?.readText) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    navigator.clipboard.readText().then(sendPaste, sendCtrlV);
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
