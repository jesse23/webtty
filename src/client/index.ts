import { FitAddon, init, Terminal } from '/dist/ghostty-web.js';

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
  cursorBlink: boolean;
  scrollback: number;
  theme: Theme;
  copyOnSelect: boolean;
  rightClickBehavior: 'default' | 'copyPaste';
}

const sessionId = window.location.pathname.split('/s/')[1] ?? 'main';
const config: ClientConfig = await fetch('/api/config').then((r) => r.json());

document.title = `${sessionId} | webtty`;

await init();

const term = new Terminal({
  cols: config.cols,
  rows: config.rows,
  cursorBlink: config.cursorBlink,
  fontSize: config.fontSize,
  fontFamily: config.fontFamily,
  scrollback: Math.ceil(config.scrollback / 80),
  theme: config.theme,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

const container = document.getElementById('terminal') as HTMLElement;
await term.open(container);
fitAddon.fit();
fitAddon.observeResize();

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

term.onData((data: string) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
});

term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
});

window.addEventListener('resize', () => {
  fitAddon.fit();
});

if (config.copyOnSelect) {
  term.onSelectionChange(() => {
    const selection = term.getSelection() as string;
    if (!selection) return;
    navigator.clipboard.writeText(selection).catch(() => {
      /* empty */
    });
  });
}

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
