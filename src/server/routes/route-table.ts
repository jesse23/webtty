// The webtty HTTP routes as one ordered table, and the request handler built from it
// (ADR 062). Wiring: the order below is the order of the old handleRequest if-chain, and the
// first match wins, so precedence is unchanged.
import type http from 'node:http';
import type { Config } from '../../config';
import { sendText } from '../http/respond';
import { ANY_PATH, createRouter, type Route } from '../http/router';
import type { SessionStore } from '../sessions/session-store';
import { assetRoutes } from './asset-routes';
import { configRoutes } from './config-routes';
import { executeRoutes } from './execute-route';
import { pageRoutes, pidRoutes } from './page-routes';
import { publishRoutes } from './publish-route';
import type { SpawnFn } from './run-command';
import { serverRoutes } from './server-routes';
import { sessionRoutes } from './session-routes';

/** Everything the routes need from the composition root. */
export interface RouteDeps {
  store: SessionStore;
  /** Called per request (`/api/config`) and per command (`/execute`), never cached. */
  loadConfig: () => Config;
  /** The wasm served at `/ghostty-vt-small.wasm`. */
  wasmPath: string;
  /** The client dist directory. */
  clientDistPath: string;
  /** Invoked by `POST /api/server/stop` after it replies. */
  onStop: () => void;
  /** The child-process spawner for `/execute`; node's when omitted. */
  spawn?: SpawnFn;
}

/** The CORS preflight: `204` with no body on any path. */
const preflight: Route = {
  method: 'OPTIONS',
  path: ANY_PATH,
  handle: ({ res }) => sendText(res, 204),
};

/** Every route, in the old if-chain's order. Unmatched requests end in the router's 404. */
export function createRouteTable(deps: RouteDeps): Route[] {
  return [
    preflight, //                 1. OPTIONS on any path
    ...serverRoutes(deps), //     2. POST /api/server/stop, 3. GET /api/server/status
    ...configRoutes(deps), //     4. GET /api/config
    ...sessionRoutes(deps), //    5. /api/sessions (GET, POST), 6. /api/sessions/:id
    ...pageRoutes(deps), //       7. GET / and /index.html, 8. GET /s/:id
    ...publishRoutes(deps), //    9. POST /s/:id/publish
    ...executeRoutes(deps), //   10. POST /s/:id/execute
    ...pidRoutes(deps), //       11. GET /p/:pid
    ...assetRoutes(deps), //     12. /dist/*, 13. /ghostty-vt-small.wasm
  ];
}

/** The server's request handler: the route table behind the router. */
export function createRequestHandler(
  deps: RouteDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return createRouter(createRouteTable(deps));
}
