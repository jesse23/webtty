import { FitAddon, init, Terminal } from 'ghostty-web';
import { applyDecscusr } from './cursor';

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
  keyboardBindings: KeyboardBinding[];
}

const sessionId = window.location.pathname.split('/s/')[1] ?? 'main';

// BroadcastChannel focus handshake — focus existing tab instead of mounting a duplicate.
// Post a focus-request; if an existing tab acks within 200ms, show a fallback UI instead
// of mounting a second terminal to the same PTY. See deep-link spec.
const focusChannel = new BroadcastChannel(`webtty:focus:${sessionId}`);
const isPrimary = await new Promise<boolean>((resolve) => {
  const timeout = setTimeout(() => resolve(true), 200);
  focusChannel.onmessage = (e: MessageEvent) => {
    if (e.data.type === 'focus-ack') {
      clearTimeout(timeout);
      resolve(false);
    } else if (e.data.type === 'focus-request') {
      window.focus();
      focusChannel.postMessage({ type: 'focus-ack' });
    }
  };
  focusChannel.postMessage({ type: 'focus-request', sessionId });
});

if (!isPrimary) {
  (document.getElementById('terminal') as HTMLElement).textContent =
    'Session already open in another tab.';
} else {
  // This is the primary tab — respond to focus-requests from future tabs.
  focusChannel.onmessage = (e: MessageEvent) => {
    if (e.data.type === 'focus-request') {
      window.focus();
      focusChannel.postMessage({ type: 'focus-ack' });
    }
  };

  const config: ClientConfig = await fetch('/api/config').then((r) => r.json());

  document.title = `${sessionId} | webtty`;

  await init();

  const term = new Terminal({
    cols: config.cols,
    rows: config.rows,
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorStyleBlink,
    fontSize: config.fontSize,
    fontFamily: config.fontFamily,
    scrollback: Math.ceil(config.scrollback / 80),
    theme: config.theme,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const container = document.getElementById('terminal') as HTMLElement;
  if (config.theme?.background) {
    container.style.background = config.theme.background;
  }
  await term.open(container);

  // FitAddon computes cols = floor((containerWidth - scrollbarReserve) / charWidth),
  // leaving a gap larger than one sub-cell. Measure the actual canvas dimensions
  // after fitting and distribute the gap as padding so the canvas fills exactly.
  // Padding must be cleared first: FitAddon reads it from computed style and
  // subtracts it before computing cols, so stale padding would shrink the result.
  function fit(): void {
    container.style.padding = '0';
    fitAddon.fit();
    const canvas = container.querySelector('canvas') as HTMLElement | null;
    if (!canvas) return;
    const hGap = Math.max(0, container.clientWidth - canvas.offsetWidth);
    const vGap = Math.max(0, container.clientHeight - canvas.offsetHeight);
    container.style.paddingLeft = `${Math.floor(hGap / 2)}px`;
    container.style.paddingRight = `${Math.ceil(hGap / 2)}px`;
    container.style.paddingTop = `${Math.floor(vGap / 2)}px`;
    container.style.paddingBottom = `${Math.ceil(vGap / 2)}px`;
  }

  fit();
  new ResizeObserver(() => fit()).observe(container, { box: 'border-box' });

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws: WebSocket;

  function connect(): void {
    const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}?cols=${term.cols}&rows=${term.rows}`;
    ws = new WebSocket(wsUrl);

    const DIM = '\x1b[2m',
      YELLOW = '\x1b[1;33m',
      ITALIC = '\x1b[3m',
      RESET = '\x1b[0m';
    const tag = `${DIM}[${RESET} ${YELLOW}webtty${RESET} ${DIM}]${RESET}`;
    const msg = (text: string): string => `\r\n${tag} ${DIM}${ITALIC}${text}${RESET}\r\n`;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      applyDecscusr(term, event.data);
      term.write(event.data);
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

  // Intercept configured key+mods combos before ghostty-web sees them and send
  // the bound chars directly to the PTY. See ADR 018.
  container.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const active = new Set([
        ...(e.shiftKey ? ['shift'] : []),
        ...(e.ctrlKey ? ['ctrl'] : []),
        ...(e.altKey ? ['alt'] : []),
        ...(e.metaKey ? ['meta'] : []),
      ]);
      const binding = config.keyboardBindings.find((b) => {
        if (b.key.toLowerCase() !== key) return false;
        const required = new Set((Array.isArray(b.mods) ? b.mods : []).map((m) => m.toLowerCase()));
        if (required.size !== active.size) return false;
        for (const m of required) if (!active.has(m)) return false;
        return true;
      });
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
  // xterm.js). When clipboard has no text/plain, its paste handler drops it
  // too. Send \x16 so TUI apps can invoke their native OS clipboard read.
  // See ADR 014.
  container.addEventListener(
    'paste',
    (e: ClipboardEvent) => {
      const cd = e.clipboardData;
      if (!cd) return;
      if (cd.getData('text/plain')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('\x16');
      }
    },
    { capture: true },
  );
}
