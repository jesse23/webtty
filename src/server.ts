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

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

interface Session {
  id: string;
  createdAt: number;
  pty: PtyProcess | null; // null until first WebSocket connect
  ws: WS | null; // currently connected WebSocket, if any
}

const sessionRegistry = new Map<string, Session>();
let lastUsedId: string | null = null;

const ID_RE = /^[a-z0-9\-_.]{1,64}$/;

function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

function generateId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}

function createSession(id: string): Session {
  const session: Session = { id, createdAt: Date.now(), pty: null, ws: null };
  sessionRegistry.set(id, session);
  return session;
}

function sessionToJson(s: Session) {
  return { id: s.id, createdAt: s.createdAt, connected: s.ws !== null };
}

// ---------------------------------------------------------------------------
// ghostty-web asset resolution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SPA shell — session ID injected so the browser-side JS can read it
// ---------------------------------------------------------------------------

function spaShell(sessionId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>webtty — ${sessionId}</title>
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

      const sessionId = ${JSON.stringify(sessionId)};
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;

      function connect() {
        const wsUrl = protocol + '//' + window.location.host + '/ws/' + sessionId + '?cols=' + term.cols + '&rows=' + term.rows;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          console.log('[webtty] connected to session ' + sessionId);
        };

        ws.onmessage = (event) => {
          term.write(event.data);
        };

        ws.onclose = () => {
          console.log('[webtty] disconnected, reconnecting in 2s...');
          term.write('\\r\\n\\x1b[31mConnection closed. Reconnecting in 2s...\\x1b[0m\\r\\n');
          setTimeout(connect, 2000);
        };

        ws.onerror = () => {
          console.error('[webtty] websocket error');
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
}

// ---------------------------------------------------------------------------
// PTY helpers
// ---------------------------------------------------------------------------

function spawnPtyForSession(cols: number, rows: number): PtyProcess {
  const shell =
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash');
  return spawnPty(shell, cols, rows);
}

// ---------------------------------------------------------------------------
// JSON body parser helper
// ---------------------------------------------------------------------------

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  // --- Server control -------------------------------------------------------

  if (req.method === 'POST' && pathname === '/api/server/stop') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('stopping');
    for (const session of sessionRegistry.values()) {
      session.pty?.kill();
      session.ws?.close();
    }
    wss.close();
    httpServer.close(() => process.exit(0));
    return;
  }

  // --- Session REST API -----------------------------------------------------

  if (pathname === '/api/sessions') {
    if (req.method === 'GET') {
      const list = [...sessionRegistry.values()].map(sessionToJson);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === 'POST') {
      let body: { id?: string };
      try {
        body = (await readJson(req)) as { id?: string };
      } catch {
        res.writeHead(400);
        res.end('invalid JSON');
        return;
      }

      const id = body.id ?? generateId();
      if (!isValidId(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid id: ${id}` }));
        return;
      }
      if (sessionRegistry.has(id)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `session already exists: ${id}` }));
        return;
      }
      const session = createSession(id);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionToJson(session)));
      return;
    }
  }

  // /api/sessions/:id
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);

    if (req.method === 'GET') {
      const session = sessionRegistry.get(id);
      if (!session) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionToJson(session)));
      return;
    }

    if (req.method === 'PATCH') {
      let body: { id?: string };
      try {
        body = (await readJson(req)) as { id?: string };
      } catch {
        res.writeHead(400);
        res.end('invalid JSON');
        return;
      }

      const session = sessionRegistry.get(id);
      if (!session) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const newId = body.id;
      if (!newId) {
        res.writeHead(400);
        res.end('missing id');
        return;
      }
      if (!isValidId(newId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid id: ${newId}` }));
        return;
      }
      if (sessionRegistry.has(newId)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `session already exists: ${newId}` }));
        return;
      }
      sessionRegistry.delete(id);
      session.id = newId;
      sessionRegistry.set(newId, session);
      if (lastUsedId === id) lastUsedId = newId;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionToJson(session)));
      return;
    }

    if (req.method === 'DELETE') {
      const session = sessionRegistry.get(id);
      if (!session) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      session.pty?.kill();
      session.ws?.close();
      sessionRegistry.delete(id);
      if (lastUsedId === id) lastUsedId = null;
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // --- Browser routes -------------------------------------------------------

  // GET / — redirect to last-used or create 'main' and redirect
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    let targetId = lastUsedId ?? null;
    if (!targetId || !sessionRegistry.has(targetId)) {
      if (!sessionRegistry.has('main')) createSession('main');
      targetId = 'main';
    }
    res.writeHead(302, { Location: `/s/${targetId}` });
    res.end();
    return;
  }

  // GET /s/:id — serve SPA shell
  const spaMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (req.method === 'GET' && spaMatch) {
    const id = decodeURIComponent(spaMatch[1]);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(spaShell(id));
    return;
  }

  // --- Static assets --------------------------------------------------------

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

// ---------------------------------------------------------------------------
// WebSocket — /ws/:id
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (wsMatch) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws: WS, req: http.IncomingMessage) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!wsMatch) {
    ws.close();
    return;
  }

  const id = decodeURIComponent(wsMatch[1]);
  const cols = Number.parseInt(url.searchParams.get('cols') ?? '80', 10);
  const rows = Number.parseInt(url.searchParams.get('rows') ?? '24', 10);

  // Ensure session exists in registry (implicit create on WS connect)
  if (!sessionRegistry.has(id)) createSession(id);
  const session = sessionRegistry.get(id) ?? createSession(id);

  // Attach WebSocket
  session.ws = ws;
  lastUsedId = id;

  // Create PTY if this is the first connect, otherwise reuse
  if (!session.pty) {
    session.pty = spawnPtyForSession(cols, rows);

    session.pty.onData((data: string) => {
      if (ws.readyState === ws.OPEN) ws.send(data, { binary: false });
    });

    session.pty.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`);
        ws.close();
      }
      session.pty = null;
    });

    const C = '\x1b[1;36m';
    const G = '\x1b[1;32m';
    const Y = '\x1b[1;33m';
    const R = '\x1b[0m';
    ws.send(`${C}╔══════════════════════════════════════════════════════════════╗${R}\r\n`);
    ws.send(
      `${C}║${R}  ${G}Welcome to webtty!${R}                                            ${C}║${R}\r\n`,
    );
    ws.send(`${C}║${R}                                                              ${C}║${R}\r\n`);
    ws.send(`${C}║${R}  You have a real shell session with full PTY support.        ${C}║${R}\r\n`);
    ws.send(
      `${C}║${R}  Try: ${Y}ls${R}, ${Y}cd${R}, ${Y}top${R}, ${Y}vim${R}, or any command!                      ${C}║${R}\r\n`,
    );
    ws.send(`${C}╚══════════════════════════════════════════════════════════════╝${R}\r\n\r\n`);
  }

  ws.on('message', (data: Buffer) => {
    const message = data.toString('utf8');
    if (message.startsWith('{')) {
      try {
        const msg = JSON.parse(message) as { type: string; cols: number; rows: number };
        if (msg.type === 'resize') {
          session.pty?.resize(msg.cols, msg.rows);
          return;
        }
      } catch {
        // fall through
      }
    }
    session.pty?.write(message);
  });

  ws.on('close', () => {
    if (session.ws === ws) session.ws = null;
  });

  ws.on('error', () => {});
});

// ---------------------------------------------------------------------------
// Graceful shutdown on SIGINT
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  console.log('\n\nShutting down...');
  for (const session of sessionRegistry.values()) {
    session.pty?.kill();
    session.ws?.close();
  }
  wss.close();
  process.exit(0);
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${HTTP_PORT}`);
});
