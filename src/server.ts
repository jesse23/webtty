import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from '@lydell/node-pty';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 2346;

const require = createRequire(import.meta.url);
const ghosttyWebMain = require.resolve('ghostty-web') as string;
const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, '');
const distPath = path.join(ghosttyWebRoot, 'dist');
const wasmPath = path.join(ghosttyWebRoot, 'ghostty-vt.wasm');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>wtty</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      body {
        background: #282A36;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
      }

      .terminal-window {
        width: 100%;
        max-width: 1200px;
        background: #282A36;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        overflow: hidden;
      }

      .title-bar {
        background: #21222C;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid #1a1a1a;
      }

      .traffic-lights { display: flex; gap: 8px; }
      .light { width: 12px; height: 12px; border-radius: 50%; }
      .light.red    { background: #ff5f56; }
      .light.yellow { background: #ffbd2e; }
      .light.green  { background: #27c93f; }

      .title { color: #F8F8F2; font-size: 13px; font-weight: 500; }

      .connection-status {
        margin-left: auto;
        font-size: 11px;
        color: #6272A4;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #6272A4; }
      .status-dot.connected    { background: #50FA7B; }
      .status-dot.disconnected { background: #FF5555; }
      .status-dot.connecting   { background: #F1FA8C; animation: pulse 1s infinite; }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50%       { opacity: 0.5; }
      }

      .terminal-content {
        height: 600px;
        padding: 16px;
        background: #282A36;
        position: relative;
        overflow: hidden;
      }

      .terminal-content canvas { display: block; }

      @media (max-width: 768px) {
        .terminal-content { height: 500px; }
      }
    </style>
  </head>
  <body>
    <div class="terminal-window">
      <div class="title-bar">
        <div class="traffic-lights">
          <div class="light red"></div>
          <div class="light yellow"></div>
          <div class="light green"></div>
        </div>
        <span class="title">wtty</span>
        <div class="connection-status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">Connecting...</span>
        </div>
      </div>
      <div class="terminal-content" id="terminal"></div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

      await init();

      const term = new Terminal({
        cols: 80,
        rows: 24,
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'FiraMono Nerd Font', Menlo, Monaco, 'Courier New', monospace",
        scrollback: 10000,
        theme: {
          background:   '#282A36',
          foreground:   '#F8F8F2',
          cursor:       '#F8F8F2',
          selection:    '#44475A',
          black:        '#21222C',
          red:          '#FF5555',
          green:        '#50FA7B',
          yellow:       '#F1FA8C',
          blue:         '#BD93F9',
          purple:       '#FF79C6',
          cyan:         '#8BE9FD',
          white:        '#F8F8F2',
          brightBlack:  '#6272A4',
          brightRed:    '#FF6E6E',
          brightGreen:  '#69FF94',
          brightYellow: '#FFFFA5',
          brightBlue:   '#D6ACFF',
          brightPurple: '#FF92DF',
          brightCyan:   '#A4FFFF',
          brightWhite:  '#FFFFFF',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const container = document.getElementById('terminal');
      await term.open(container);
      fitAddon.fit();
      fitAddon.observeResize();

      const statusDot  = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      function setStatus(status, text) {
        statusDot.className = 'status-dot ' + status;
        statusText.textContent = text;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + window.location.host + '/ws?cols=' + term.cols + '&rows=' + term.rows;
      let ws;

      function connect() {
        setStatus('connecting', 'Connecting...');
        ws = new WebSocket(wsUrl);
        ws.onopen  = () => setStatus('connected', 'Connected');
        ws.onmessage = (e) => term.write(e.data);
        ws.onerror = () => setStatus('disconnected', 'Error');
        ws.onclose = () => {
          setStatus('disconnected', 'Disconnected');
          term.write('\\r\\n\\x1b[31mConnection closed. Reconnecting in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
        };
      }

      connect();

      term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });

      window.addEventListener('resize', () => fitAddon.fit());

      if (window.visualViewport) {
        const terminalContent = document.querySelector('.terminal-content');
        const terminalWindow  = document.querySelector('.terminal-window');
        const originalHeight  = terminalContent.style.height;

        window.visualViewport.addEventListener('resize', () => {
          const keyboardHeight = window.innerHeight - window.visualViewport.height;
          if (keyboardHeight > 100) {
            document.body.style.padding = '0';
            document.body.style.alignItems = 'flex-start';
            terminalWindow.style.borderRadius = '0';
            terminalWindow.style.maxWidth = '100%';
            terminalContent.style.height = (window.visualViewport.height - 60) + 'px';
            window.scrollTo(0, 0);
          } else {
            document.body.style.padding = '40px 20px';
            document.body.style.alignItems = 'center';
            terminalWindow.style.borderRadius = '12px';
            terminalWindow.style.maxWidth = '1200px';
            terminalContent.style.height = originalHeight || '600px';
          }
          fitAddon.fit();
        });
      }
    </script>
  </body>
</html>`;

function serveFile(filePath: string, res: http.ServerResponse): void {
  const ext = path.extname(filePath);
  const contentType = MIME[ext] ?? 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  if (pathname.startsWith('/dist/')) {
    serveFile(path.join(distPath, pathname.slice(6)), res);
    return;
  }
  if (pathname === '/ghostty-vt.wasm') {
    serveFile(wasmPath, res);
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

function getShell(): string {
  return process.platform === 'win32'
    ? (process.env.COMSPEC ?? 'cmd.exe')
    : (process.env.SHELL ?? '/bin/bash');
}

interface Session {
  pty: ReturnType<typeof pty.spawn>;
}

const wss = new WebSocketServer({ noServer: true });
const sessions = new Map<WS, Session>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WS, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const cols = Number.parseInt(url.searchParams.get('cols') ?? '80', 10);
  const rows = Number.parseInt(url.searchParams.get('rows') ?? '24', 10);

  const ptyProcess = pty.spawn(getShell(), [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  sessions.set(ws, { pty: ptyProcess });

  ptyProcess.onData((data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on('message', (data: Buffer) => {
    const msg = data.toString('utf8');
    if (msg.startsWith('{')) {
      try {
        const parsed = JSON.parse(msg) as { type: string; cols: number; rows: number };
        if (parsed.type === 'resize') {
          ptyProcess.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // fall through
      }
    }
    ptyProcess.write(msg);
  });

  ws.on('close', () => {
    sessions.get(ws)?.pty.kill();
    sessions.delete(ws);
  });
  ws.on('error', () => {});
});

process.on('SIGINT', () => {
  for (const [ws, { pty: p }] of sessions) {
    p.kill();
    ws.close();
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`wtty listening on http://localhost:${PORT}`);
});
