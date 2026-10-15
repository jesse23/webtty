// The WebSocket server: a `noServer` WebSocketServer behind the HTTP server's `upgrade`
// event, routing `/ws/:id/pty` to the terminal handler and `/ws/:id/events` to the event
// handler. Wiring only; the handlers and the Session do the work (ADR 062).
import type http from 'node:http';
import type { WebSocket as WS } from 'ws';
import { WebSocketServer } from 'ws';
import { loadConfig } from '../../config';
import { spawnPty } from '../../pty';
import { packageRunner } from '../../runtime';
import type { PtySpawnDeps } from '../sessions/session';
import type { SessionStore } from '../sessions/session-store';
import { WS_CLOSE } from './close-codes';
import { handleEventsSocket } from './events-socket';
import { handlePtySocket } from './pty-socket';

const PTY_PATH = /^\/ws\/([^/]+)\/pty$/;
const EVENTS_PATH = /^\/ws\/([^/]+)\/events$/;

/** The production spawn dependencies: the config file, the platform's PTY backend and runner. */
export function defaultPtySpawnDeps(): PtySpawnDeps {
  return { loadConfig, spawnPty, runner: packageRunner() };
}

function requestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
}

/**
 * Attaches a WebSocket server to `httpServer`. An upgrade to any other path has its socket
 * destroyed; an ID that is not valid percent-encoding is closed with BAD_REQUEST.
 *
 * @param httpServer - The HTTP server to attach the WebSocket server to.
 * @param store - The server's sessions; its `onEmpty` runs once the last shell has exited.
 * @param deps - How sessions spawn their shell (tests pass a fake PTY).
 * @returns The configured {@link WebSocketServer}.
 */
export function createWebSocketServer(
  httpServer: http.Server,
  store: SessionStore,
  deps: PtySpawnDeps = defaultPtySpawnDeps(),
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = requestUrl(req);
    if (pathname.match(PTY_PATH) || pathname.match(EVENTS_PATH)) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WS, req: http.IncomingMessage) => {
    const url = requestUrl(req);
    const ptyMatch = url.pathname.match(PTY_PATH);
    const eventsMatch = url.pathname.match(EVENTS_PATH);
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

    if (eventsMatch) handleEventsSocket(store, ws, id);
    else handlePtySocket(store, ws, id, url.searchParams, deps);
  });

  return wss;
}
