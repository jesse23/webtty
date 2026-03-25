import type http from 'node:http';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../config';
import { spawnForSession } from '../pty';
import type { Session } from './session';
import { sessionRegistry, setLastUsedId } from './session';

const WS_CLOSE = {
  SERVER_STOPPED: 1001 as const, // RFC 6455: server going away
  BAD_REQUEST: 1008 as const, // RFC 6455: policy violation / bad data
  SESSION_GONE: 4001 as const, // app-level: session deleted or shell exited
} as const;

function closeClients(session: Session, code: number, reason: string): void {
  session.pty?.kill();
  for (const client of session.clients) client.close(code, reason);
}

export function closeSession(session: Session): void {
  closeClients(session, WS_CLOSE.SESSION_GONE, 'session deleted');
}

export function closeAllSessions(): void {
  for (const session of sessionRegistry.values()) {
    closeClients(session, WS_CLOSE.SERVER_STOPPED, 'server stopped');
  }
}

let onLastSessionClosed: (() => void) | null = null;

export function setLastSessionClosedHandler(handler: () => void): void {
  onLastSessionClosed = handler;
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[1;36m';

const isBun = process.execPath.includes('bun');
const PKG_RUNNER = isBun ? 'bunx' : 'npx';

function sessionBanner(): string {
  const W = 48;
  const pipe = (content: string) => `${CYAN}║${RESET}${content}${CYAN}║${RESET}`;
  const blank = pipe(' '.repeat(W));

  const titleVis = ' [ webtty ]   Terminal UI in the browser';
  const titleStr = ` ${DIM}[${RESET} ${BOLD}${YELLOW}webtty${RESET} ${DIM}]   Terminal UI in the browser${RESET}`;
  const titleLine = pipe(titleStr + ' '.repeat(W - titleVis.length));

  const cmd = `${PKG_RUNNER} webtty help`;
  const helpVis = ` Run \`${cmd}\` for more information.`;
  const helpStr = ` ${DIM}Run \`${RESET}${ITALIC}${cmd}${RESET}${DIM}\` for more information.${RESET}`;
  const helpLine = pipe(helpStr + ' '.repeat(W - helpVis.length));

  return [
    `${CYAN}╔${'═'.repeat(W)}╗${RESET}`,
    '\r\n',
    blank,
    '\r\n',
    titleLine,
    '\r\n',
    blank,
    '\r\n',
    helpLine,
    '\r\n',
    blank,
    '\r\n',
    `${CYAN}╚${'═'.repeat(W)}╝${RESET}`,
    '\r\n',
    '\r\n',
  ].join('');
}

export function createWebSocketServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname.match(/^\/ws\/([^/]+)$/)) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WS, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (!wsMatch) {
      ws.close();
      return;
    }

    let id: string;
    try {
      id = decodeURIComponent(wsMatch[1]);
    } catch {
      ws.close(WS_CLOSE.BAD_REQUEST, 'Bad Request');
      return;
    }
    const cols = Math.max(
      1,
      Math.min(1000, Number.parseInt(url.searchParams.get('cols') ?? '80', 10) || 80),
    );
    const rows = Math.max(
      1,
      Math.min(500, Number.parseInt(url.searchParams.get('rows') ?? '24', 10) || 24),
    );

    if (!sessionRegistry.has(id)) {
      ws.close(WS_CLOSE.SESSION_GONE, 'session deleted');
      return;
    }

    const session = sessionRegistry.get(id);
    if (!session) {
      ws.close(WS_CLOSE.SESSION_GONE, 'session deleted');
      return;
    }
    session.clients.add(ws);
    setLastUsedId(id);

    if (!session.pty) {
      const config = loadConfig();
      session.pty = spawnForSession(cols, rows, config.shell, config.term, config.colorTerm);

      session.pty.onData((data: string) => {
        session.scrollback = (session.scrollback + data).slice(-config.scrollback);
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
            client.close(WS_CLOSE.SESSION_GONE, 'shell exited');
          }
        }
        session.pty = null;
        if (sessionRegistry.size === 0) onLastSessionClosed?.();
      });

      const banner = sessionBanner();
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
            const c = Math.max(1, Math.min(1000, Math.trunc(msg.cols) || 80));
            const r = Math.max(1, Math.min(500, Math.trunc(msg.rows) || 24));
            session.pty?.resize(c, r);
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
