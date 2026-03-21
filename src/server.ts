import fs from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from '@lydell/node-pty';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 2346;

const ghosttyRoot = path.resolve(__dirname, '../node_modules/ghostty-web');
const distPath = path.join(ghosttyRoot, 'dist');
const wasmPath = path.join(ghosttyRoot, 'ghostty-vt.wasm');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.json': 'application/json',
};

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>wtty</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; background: #282A36; overflow: hidden; }
      #terminal { width: 100%; height: 100%; padding: 8px; }
      #terminal canvas { display: block; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>
    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

      await init();

      const term = new Terminal({
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
      await term.open(document.getElementById('terminal'));
      fitAddon.fit();
      fitAddon.observeResize();
      window.addEventListener('resize', () => fitAddon.fit());

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;

      function connect() {
        ws = new WebSocket(protocol + '//' + location.host + '/ws?cols=' + term.cols + '&rows=' + term.rows);
        ws.onmessage = (e) => term.write(e.data);
        ws.onclose = () => setTimeout(connect, 2000);
      }

      connect();

      term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      });
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
  const pathname = url.pathname;

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

const wss = new WebSocketServer({ noServer: true });
const sessions = new Map<WebSocket, ReturnType<typeof pty.spawn>>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const cols = Number.parseInt(url.searchParams.get('cols') ?? '80', 10);
  const rows = Number.parseInt(url.searchParams.get('rows') ?? '24', 10);

  const shell = getShell();
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  sessions.set(ws, ptyProcess);

  ptyProcess.onData((data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on('message', (data) => {
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
    sessions.get(ws)?.kill();
    sessions.delete(ws);
  });

  ws.on('error', () => {});
});

process.on('SIGINT', () => {
  for (const [ws, ptyProcess] of sessions) {
    ptyProcess.kill();
    ws.close();
  }
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`wtty listening on http://localhost:${PORT}`);
});
