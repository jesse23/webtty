import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';
import { type PtyProcess, spawn as spawnPty } from './pty';
import { ghosttyWebRootFromMain, mimeType } from './utils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = Number(process.env.PORT) || 2346;

const require = createRequire(import.meta.url);

function findGhosttyWeb(): { distPath: string; wasmPath: string } {
  try {
    const ghosttyWebMain = require.resolve('ghostty-web') as string;
    const ghosttyWebRoot = ghosttyWebRootFromMain(ghosttyWebMain);
    const distPath = path.join(ghosttyWebRoot, 'dist');
    const wasmPath = path.join(ghosttyWebRoot, 'ghostty-vt.wasm');
    if (fs.existsSync(path.join(distPath, 'ghostty-web.js')) && fs.existsSync(wasmPath)) {
      return { distPath, wasmPath };
    }
  } catch {
    // fall through
  }
  console.error('Error: Could not find ghostty-web package.');
  process.exit(1);
}

const { distPath, wasmPath } = findGhosttyWeb();

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>wtty</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }

      html, body, #terminal { width: 100%; height: 100%; overflow: hidden; background: #282A36; }

      #terminal canvas { display: block; }
    </style>
  </head>
  <body>
    <div id="terminal"></div>

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

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + window.location.host + '/ws?cols=' + term.cols + '&rows=' + term.rows;
      let ws;

      function connect() {
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log('[wtty] connected');
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = () => {
          console.log('[wtty] disconnected, reconnecting in 2s...');
          term.write('\\r\\n\\x1b[31mConnection closed. Reconnecting in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          console.error('[wtty] websocket error');
        };
      }

      connect();

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      term.onResize(({ cols, rows }) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });

      window.addEventListener('resize', () => {
        fitAddon.fit();
      });
    </script>
  </body>
</html>`;

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/server/stop') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('stopping');
    for (const [ws, session] of sessions.entries()) {
      session.pty.kill();
      ws.close();
    }
    wss.close();
    httpServer.close(() => process.exit(0));
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_TEMPLATE);
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

function serveFile(filePath: string, res: http.ServerResponse): void {
  const contentType = mimeType(filePath);
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

const sessions = new Map<WS, { pty: PtyProcess }>();

function createPtySession(cols: number, rows: number): PtyProcess {
  const shell =
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash');
  return spawnPty(shell, cols, rows);
}

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
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

  const ptyProcess = createPtySession(cols, rows);
  sessions.set(ws, { pty: ptyProcess });

  ptyProcess.onData((data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data, { binary: false });
  });

  ptyProcess.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
      ws.close();
    }
  });

  ws.on('message', (data: Buffer) => {
    const message = data.toString('utf8');
    if (message.startsWith('{')) {
      try {
        const msg = JSON.parse(message) as { type: string; cols: number; rows: number };
        if (msg.type === 'resize') {
          ptyProcess.resize(msg.cols, msg.rows);
          return;
        }
      } catch {
        // fall through
      }
    }
    ptyProcess.write(message);
  });

  ws.on('close', () => {
    sessions.get(ws)?.pty.kill();
    sessions.delete(ws);
  });

  ws.on('error', () => {});

  const C = '\x1b[1;36m';
  const G = '\x1b[1;32m';
  const Y = '\x1b[1;33m';
  const R = '\x1b[0m';
  ws.send(`${C}╔══════════════════════════════════════════════════════════════╗${R}\r\n`);
  ws.send(
    `${C}║${R}  ${G}Welcome to wtty!${R}                                            ${C}║${R}\r\n`,
  );
  ws.send(`${C}║${R}                                                              ${C}║${R}\r\n`);
  ws.send(`${C}║${R}  You have a real shell session with full PTY support.        ${C}║${R}\r\n`);
  ws.send(
    `${C}║${R}  Try: ${Y}ls${R}, ${Y}cd${R}, ${Y}top${R}, ${Y}vim${R}, or any command!                      ${C}║${R}\r\n`,
  );
  ws.send(`${C}╚══════════════════════════════════════════════════════════════╝${R}\r\n\r\n`);
});

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  for (const [ws, session] of sessions.entries()) {
    session.pty.kill();
    ws.close();
  }
  wss.close();
  process.exit(0);
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`listening on http://localhost:${HTTP_PORT}`);
});
