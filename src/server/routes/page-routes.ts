// The pages a browser opens: `/` redirects to a session, `/s/:id` serves the client page and
// `/p/:pid` finds a session by its shell's PID (ADR 062, deep-link SPEC). Route handlers.
import path from 'node:path';
import { decodeId } from '../http/request-body';
import { redirect, sendNotFound } from '../http/respond';
import type { Route } from '../http/router';
import { serveFile } from '../http/static-files';
import { isValidId } from '../sessions/session-id';
import type { SessionStore } from '../sessions/session-store';

/** What the page routes need. */
export interface PageRouteDeps {
  store: SessionStore;
  /** The directory holding client.html. */
  clientDistPath: string;
}

/** The root redirect and the `/s/:id` page. */
export function pageRoutes(deps: PageRouteDeps): Route[] {
  const { store } = deps;
  const root: Route['handle'] = ({ res }) => {
    // The last session a client used, else `main`, created on demand.
    let targetId = store.lastUsedId;
    if (!targetId || !store.has(targetId)) {
      if (!store.has('main')) store.create('main');
      targetId = 'main';
    }
    redirect(res, `/s/${targetId}`);
  };
  return [
    { method: 'GET', path: '/', handle: root },
    { method: 'GET', path: '/index.html', handle: root },
    {
      method: 'GET',
      path: /^\/s\/([^/]+)$/,
      handle: ({ res, params }) => {
        const id = decodeId(params[0]);
        if (!id || !isValidId(id) || !store.has(id)) {
          sendNotFound(res);
          return;
        }
        serveFile(path.resolve(deps.clientDistPath, 'client.html'), res);
      },
    },
  ];
}

/** `GET /p/:pid`: a 302 to the session whose shell has that PID, else 404. */
export function pidRoutes(deps: Pick<PageRouteDeps, 'store'>): Route[] {
  return [
    {
      method: 'GET',
      path: /^\/p\/(\d+)$/,
      handle: ({ res, params }) => {
        const pid = parseInt(params[0], 10);
        const session = Number.isFinite(pid) && pid > 0 ? deps.store.findByPid(pid) : undefined;
        if (!session) {
          sendNotFound(res);
          return;
        }
        redirect(res, `/s/${session.id}`);
      },
    },
  ];
}
