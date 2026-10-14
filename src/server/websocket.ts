import type http from 'node:http';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../config';
import { spawnForSession } from '../pty';
import { packageRunner } from '../runtime';
import type { Session } from './session';
import { sessionRegistry, setLastUsedId } from './session';
import { sessionBanner } from './sessions/session-banner';
import { parseClientMessage, sizeFromQuery } from './ws/client-message';
import { WS_CLOSE } from './ws/close-codes';

function closeClients(session: Session, code: number, reason: string): void {
  session.pty?.kill();
  for (const client of session.clients) client.close(code, reason);
  for (const sub of session.subscribers) sub.close(code, reason);
  session.subscribers.clear();
}

/**
 * Closes all WebSocket clients for `session` with the SESSION_GONE close code.
 *
 * @param session - The session to close.
 */
export function closeSession(session: Session): void {
  closeClients(session, WS_CLOSE.SESSION_GONE, 'session deleted');
}

/** Closes all WebSocket clients across every active session with the SERVER_STOPPED close code. */
export function closeAllSessions(): void {
  for (const session of sessionRegistry.values()) {
    closeClients(session, WS_CLOSE.SERVER_STOPPED, 'server stopped');
  }
}

/**
 * Sends `line` to all open event subscribers of `session`.
 *
 * @param session - The session whose subscribers to notify.
 * @param line - The line to send.
 */
export function broadcastToSubscribers(session: Session, line: string): void {
  for (const sub of session.subscribers) {
    if (sub.readyState === sub.OPEN) sub.send(line);
  }
}

let onLastSessionClosed: (() => void) | null = null;

/**
 * Registers a callback invoked once the last session closes (e.g. to stop the HTTP server).
 *
 * @param handler - Callback to invoke when the last session closes.
 */
export function setLastSessionClosedHandler(handler: () => void): void {
  onLastSessionClosed = handler;
}

const PKG_RUNNER = packageRunner();

function handleSubscribe(ws: WS, id: string): void {
  const session = sessionRegistry.get(id);
  if (!session) {
    ws.close(WS_CLOSE.SESSION_GONE, 'session deleted');
    return;
  }
  if (session.pty === null) {
    ws.close(WS_CLOSE.PTY_NOT_RUNNING, 'PTY not running');
    return;
  }
  session.subscribers.add(ws);
  ws.on('close', () => {
    session.subscribers.delete(ws);
  });
  ws.on('error', () => {});
}

/**
 * Attaches a WebSocket server to `httpServer`, handling PTY I/O, session management,
 * scrollback replay, and terminal resize for all `/ws/:id/pty` connections,
 * and event subscriptions for `/ws/:id/events` connections.
 *
 * @param httpServer - The HTTP server to attach the WebSocket server to.
 * @returns The configured {@link WebSocketServer}.
 */
export function createWebSocketServer(httpServer: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (
      url.pathname.match(/^\/ws\/([^/]+)\/pty$/) ||
      url.pathname.match(/^\/ws\/([^/]+)\/events$/)
    ) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WS, req: http.IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const ptyMatch = url.pathname.match(/^\/ws\/([^/]+)\/pty$/);
    const eventsMatch = url.pathname.match(/^\/ws\/([^/]+)\/events$/);
    const match = ptyMatch ?? eventsMatch;

    if (!match) {
      ws.close();
      return;
    }

    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      ws.close(WS_CLOSE.BAD_REQUEST, 'Bad Request');
      return;
    }

    if (eventsMatch) {
      handleSubscribe(ws, id);
      return;
    }

    const { cols, rows } = sizeFromQuery(url.searchParams);

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
    // A client that acknowledges output says so in the URL; one without it predates
    // ADR 048 (a tab loaded before an upgrade) and is sent output unpaced.
    session.output.add(ws, url.searchParams.get('flow') === '1');
    setLastUsedId(id);

    if (!session.pty) {
      const config = loadConfig();
      session.pty = spawnForSession(
        cols,
        rows,
        config.shell,
        config.term,
        config.colorTerm,
        session.baseDir,
        config.env,
      );

      session.pty.onData((data: string) => {
        session.scrollback = (session.scrollback + data).slice(-config.scrollback);
        session.output.broadcast(data);
      });

      session.pty.onExit(() => {
        sessionRegistry.delete(session.id);
        for (const sub of session.subscribers) {
          if (sub.readyState === sub.OPEN) {
            sub.close(WS_CLOSE.SESSION_GONE, 'shell exited');
          }
        }
        session.subscribers.clear();
        session.pty = null;
        // A client behind the output is sent what is queued for it before it is closed,
        // so the last lines the shell wrote are not lost (ADR 048).
        session.output.end(WS_CLOSE.SESSION_GONE, 'shell exited').then(() => {
          if (sessionRegistry.size === 0) onLastSessionClosed?.();
        });
      });

      const banner = sessionBanner(PKG_RUNNER);
      session.output.send(ws, banner);
      session.scrollback = banner;
      session.pty.write('\n');
    } else {
      if (session.scrollback) {
        session.output.send(ws, session.scrollback);
      }
      session.pty.resize(cols, rows);
    }

    ws.on('message', (data: Buffer) => {
      const message = data.toString('utf8');
      const msg = parseClientMessage(message);
      try {
        if (msg.type === 'ack') {
          session.output.ack(ws, msg.chars);
          return;
        }
        if (msg.type === 'resize') {
          session.pty?.resize(msg.cols, msg.rows);
          return;
        }
      } catch {
        // A control message whose handling throws (node-pty refuses to resize a PTY that
        // has exited) is written to the PTY as raw input, as it always has been.
      }
      session.pty?.write(message);
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      session.output.remove(ws);
    });

    ws.on('error', () => {});
  });

  return wss;
}
