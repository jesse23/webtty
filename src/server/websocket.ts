import type http from 'node:http';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';
import { spawnForSession } from '../pty';
import { SCROLLBACK_MAX, sessionRegistry, setLastUsedId } from './session';

export function createWebSocketServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.match(/^\/ws\/([^/]+)$/)) {
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

    if (!sessionRegistry.has(id)) {
      ws.close(4001, 'session deleted');
      return;
    }

    const session = sessionRegistry.get(id);
    if (!session) {
      ws.close(4001, 'session deleted');
      return;
    }
    session.clients.add(ws);
    setLastUsedId(id);

    if (!session.pty) {
      session.pty = spawnForSession(cols, rows);

      session.pty.onData((data: string) => {
        session.scrollback = (session.scrollback + data).slice(-SCROLLBACK_MAX);
        for (const client of session.clients) {
          if (client.readyState === client.OPEN) {
            client.send(data, { binary: false });
          }
        }
      });

      session.pty.onExit(() => {
        sessionRegistry.delete(session.id);
        for (const client of session.clients) {
          if (client.readyState === client.OPEN) {
            client.close(4001, 'shell exited');
          }
        }
        session.pty = null;
      });

      const C = '\x1b[1;36m';
      const G = '\x1b[1;32m';
      const Y = '\x1b[1;33m';
      const R = '\x1b[0m';
      const banner = [
        `${C}╔══════════════════════════════════════════════════════════════╗${R}\r\n`,
        `${C}║${R}  ${G}Welcome to webtty!${R}                                            ${C}║${R}\r\n`,
        `${C}║${R}                                                              ${C}║${R}\r\n`,
        `${C}║${R}  You have a real shell session with full PTY support.        ${C}║${R}\r\n`,
        `${C}║${R}  Try: ${Y}ls${R}, ${Y}cd${R}, ${Y}top${R}, ${Y}vim${R}, or any command!                      ${C}║${R}\r\n`,
        `${C}╚══════════════════════════════════════════════════════════════╝${R}\r\n\r\n`,
      ].join('');
      ws.send(banner);
      session.scrollback = banner;
      session.pty.write('\n');
    } else {
      if (session.scrollback) {
        ws.send(session.scrollback, { binary: false });
      }
      session.pty.resize(cols, rows);
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
      session.clients.delete(ws);
    });

    ws.on('error', () => {});
  });

  return wss;
}
