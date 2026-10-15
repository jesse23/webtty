// The server's own API: `POST /api/server/stop` and `GET /api/server/status` (ADR 062).
// Route handlers, in the order route-table.ts lists them.
import { getVersion } from '../../version';
import { sendJson, sendText } from '../http/respond';
import type { Route } from '../http/router';

/** What the server routes need from the composition root. */
export interface ServerRouteDeps {
  /** Shuts the server down; called after the reply is written. */
  onStop: () => void;
}

/** The stop and status routes. */
export function serverRoutes(deps: ServerRouteDeps): Route[] {
  return [
    {
      method: 'POST',
      path: '/api/server/stop',
      handle: ({ res }) => {
        sendText(res, 200, 'stopping', { 'Content-Type': 'text/plain' });
        deps.onStop();
      },
    },
    {
      method: 'GET',
      path: '/api/server/status',
      handle: ({ res }) => sendJson(res, 200, { version: getVersion() }),
    },
  ];
}
