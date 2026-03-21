import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';

interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

const USE_BUN_TERMINAL = !!process.versions.bun;
console.log(`pty: ${USE_BUN_TERMINAL ? 'Bun.Terminal' : 'node-pty'}`);

function spawnPty(shell: string, cols: number, rows: number): PtyProcess {
  if (USE_BUN_TERMINAL) {
    const proc = Bun.spawn([shell], {
      terminal: {
        cols,
        rows,
        data(_term: unknown, data: Uint8Array) {
          onDataCb?.(Buffer.from(data).toString('utf8'));
        },
      },
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    let onDataCb: ((data: string) => void) | undefined;

    proc.exited.then((exitCode) => {
      onExitCb?.({ exitCode: exitCode ?? 0 });
    });

    let onExitCb: ((e: { exitCode: number }) => void) | undefined;

    return {
      onData(cb) {
        onDataCb = cb;
      },
      onExit(cb) {
        onExitCb = cb;
      },
      write(data) {
        proc.terminal?.write(data);
      },
      resize(c, r) {
        proc.terminal?.resize(c, r);
      },
      kill() {
        proc.kill();
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePty = require('@lydell/node-pty') as typeof import('@lydell/node-pty');
  const ptyProc = nodePty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  return {
    onData(cb) {
      ptyProc.onData(cb);
    },
    onExit(cb) {
      ptyProc.onExit(cb);
    },
    write(data) {
      ptyProc.write(data);
    },
    resize(c, r) {
      ptyProc.resize(c, r);
    },
    kill() {
      ptyProc.kill();
    },
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTTP_PORT = Number(process.env.PORT) || 2346;

const require = createRequire(import.meta.url);

function findGhosttyWeb(): { distPath: string; wasmPath: string } {
  try {
    const ghosttyWebMain = require.resolve('ghostty-web') as string;
    const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, '');
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
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 40px 20px;
      }

      .terminal-window {
        width: 100%;
        max-width: 1000px;
        background: #1e1e1e;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        overflow: hidden;
      }

      .title-bar {
        background: #2d2d2d;
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        border-bottom: 1px solid #1a1a1a;
      }

      .traffic-lights {
        display: flex;
        gap: 8px;
      }

      .light {
        width: 12px;
        height: 12px;
        border-radius: 50%;
      }

      .light.red { background: #ff5f56; }
      .light.yellow { background: #ffbd2e; }
      .light.green { background: #27c93f; }

      .title {
        color: #e5e5e5;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.3px;
      }

      .connection-status {
        margin-left: auto;
        font-size: 11px;
        color: #888;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #888;
      }

      .status-dot.connected { background: #27c93f; }
      .status-dot.disconnected { background: #ff5f56; }
      .status-dot.connecting { background: #ffbd2e; animation: pulse 1s infinite; }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      .terminal-content {
        height: 600px;
        padding: 16px;
        background: #1e1e1e;
        position: relative;
        overflow: hidden;
      }

      .terminal-content canvas {
        display: block;
      }

      @media (max-width: 768px) {
        .terminal-content {
          height: 500px;
        }
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
        fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
        fontSize: 14,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      const container = document.getElementById('terminal');
      await term.open(container);
      fitAddon.fit();
      fitAddon.observeResize();

      const statusDot = document.getElementById('status-dot');
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

        ws.onopen = () => {
          setStatus('connected', 'Connected');
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = () => {
          setStatus('disconnected', 'Disconnected');
          term.write('\\r\\n\\x1b[31mConnection closed. Reconnecting in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          setStatus('disconnected', 'Error');
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

      if (window.visualViewport) {
        const terminalContent = document.querySelector('.terminal-content');
        const terminalWindow = document.querySelector('.terminal-window');
        const originalHeight = terminalContent.style.height;
        const body = document.body;

        window.visualViewport.addEventListener('resize', () => {
          const keyboardHeight = window.innerHeight - window.visualViewport.height;
          if (keyboardHeight > 100) {
            body.style.padding = '0';
            body.style.alignItems = 'flex-start';
            terminalWindow.style.borderRadius = '0';
            terminalWindow.style.maxWidth = '100%';
            terminalContent.style.height = (window.visualViewport.height - 60) + 'px';
            window.scrollTo(0, 0);
          } else {
            body.style.padding = '40px 20px';
            body.style.alignItems = 'center';
            terminalWindow.style.borderRadius = '12px';
            terminalWindow.style.maxWidth = '1000px';
            terminalContent.style.height = originalHeight || '600px';
          }
          fitAddon.fit();
        });
      }
    </script>
  </body>
</html>`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

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
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
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

function getShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
}

function createPtySession(cols: number, rows: number): PtyProcess {
  return spawnPty(getShell(), cols, rows);
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
  console.log(`wtty listening on http://localhost:${HTTP_PORT}`);
});
