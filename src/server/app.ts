// The server's composition root: builds the HTTP server, the route table and the WebSocket
// server around one SessionStore, and returns them with the shutdown that stops them. A
// factory with no import-time work, so tests run the whole server in-process (ADR 062).
import http from 'node:http';
import type { WebSocketServer } from 'ws';
import type { Config } from '../config';
import { spawnForSession } from '../pty';
import { packageRunner } from '../runtime';
import { createRequestHandler } from './routes/route-table';
import type { ServerPaths } from './server-paths';
import type { SpawnPty } from './sessions/session';
import type { SessionStore } from './sessions/session-store';
import { WS_CLOSE } from './ws/close-codes';
import { createWebSocketServer } from './ws/ws-upgrade';

/** How long shutdown waits for open HTTP connections before calling `onStop` anyway. */
export const SHUTDOWN_GRACE_MS = 1000;

/** Everything the server is built from; the entry passes the production values. */
export interface ServerDeps {
  /** Called per request and per spawn, never cached, so config edits apply on the next reload (ADR 009). */
  loadConfig: () => Config;
  /** The one registry of sessions; its `onEmpty` should call {@link WebttyServer.shutdown}. */
  store: SessionStore;
  /** Starts a session's shell; `spawnForSession` from src/pty when omitted. */
  spawnPty?: SpawnPty;
  /** Where the client files and the wasm are. */
  paths: ServerPaths;
  /** Called once the server has stopped (the entry exits the process). */
  onStop: () => void;
}

/** The built server. Nothing listens until the caller calls `httpServer.listen`. */
export interface WebttyServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  /** Kills every shell, closes every socket and the servers, then calls `onStop`. */
  shutdown: () => void;
}

/**
 * Builds the webtty server: the request handler (with its 500 fallback) on a new HTTP server,
 * and the WebSocket server on its `upgrade` event.
 *
 * @param deps - The config loader, the session store, the PTY spawner, the paths and the stop hook.
 * @returns The HTTP server, the WebSocket server and `shutdown`.
 */
export function createServer(deps: ServerDeps): WebttyServer {
  const { store, loadConfig } = deps;

  // 1. The routes; `POST /api/server/stop` shuts the server down after it replies.
  const handleRequest = createRequestHandler({
    store,
    loadConfig,
    wasmPath: deps.paths.wasmPath,
    clientDistPath: deps.paths.clientRoot,
    onStop: () => shutdown(),
  });

  // 2. The HTTP server; a route that throws ends in a bare 500 if nothing was sent yet.
  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[webtty] unhandled route error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  });

  // 3. The WebSocket server on the HTTP server's upgrade event.
  const wss = createWebSocketServer(httpServer, store, {
    loadConfig,
    spawnPty: deps.spawnPty ?? spawnForSession,
    runner: packageRunner(),
  });

  function shutdown(): void {
    store.closeAll(WS_CLOSE.SERVER_STOPPED, 'server stopped');
    wss.close();
    const shutdownTimeout = setTimeout(deps.onStop, SHUTDOWN_GRACE_MS);
    httpServer.close(() => {
      clearTimeout(shutdownTimeout);
      deps.onStop();
    });
  }

  return { httpServer, wss, shutdown };
}
