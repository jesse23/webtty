// The sessions REST API: list and create on `/api/sessions`, read, rename and delete on
// `/api/sessions/:id` (ADR 062). Route handlers over the SessionStore.
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { decodeId, readJsonOrReply } from '../http/request-body';
import { sendBadRequest, sendJson, sendNotFound, sendText } from '../http/respond';
import type { Route, RouteContext } from '../http/router';
import { sessionToJson } from '../sessions/session';
import { generateId, isValidId } from '../sessions/session-id';
import type { SessionStore } from '../sessions/session-store';
import { WS_CLOSE } from '../ws/close-codes';

/** What the session routes need. */
export interface SessionRouteDeps {
  store: SessionStore;
}

/** The two session resources. */
export function sessionRoutes(deps: SessionRouteDeps): Route[] {
  const { store } = deps;
  return [
    {
      method: 'GET',
      path: '/api/sessions',
      handle: ({ res }) => sendJson(res, 200, store.list().map(sessionToJson)),
    },
    { method: 'POST', path: '/api/sessions', handle: (ctx) => createSession(ctx, store) },
    // Any method: an undecodable ID is a 400 whatever the method, as the old if-chain checked
    // it first; a method other than GET, PATCH or DELETE then ends in the 404 it fell through to.
    {
      method: '*',
      path: /^\/api\/sessions\/([^/]+)$/,
      handle: async (ctx) => {
        const id = decodeId(ctx.params[0]);
        if (!id) {
          sendBadRequest(ctx.res);
          return;
        }
        if (ctx.req.method === 'GET') readSession(ctx, store, id);
        else if (ctx.req.method === 'PATCH') await renameSession(ctx, store, id);
        else if (ctx.req.method === 'DELETE') deleteSession(ctx, store, id);
        else sendNotFound(ctx.res);
      },
    },
  ];
}

/** `POST /api/sessions` with `{ id?, baseDir? }`: 201 and the new session, or 400/409. */
async function createSession({ req, res }: RouteContext, store: SessionStore): Promise<void> {
  const read = await readJsonOrReply(req, res);
  if (!read) return;
  const body = read.value as { id?: string; baseDir?: string };

  const id = body.id ?? generateId();
  if (!isValidId(id)) {
    sendJson(res, 400, { error: `invalid id: ${id}` });
    return;
  }
  if (store.has(id)) {
    sendJson(res, 409, { error: `session already exists: ${id}` });
    return;
  }
  const baseDir = body.baseDir ?? homedir();
  if (!path.isAbsolute(baseDir)) {
    sendJson(res, 400, { error: 'baseDir must be an absolute path' });
    return;
  }
  if (!fs.existsSync(baseDir)) {
    sendJson(res, 400, { error: `baseDir does not exist: ${baseDir}` });
    return;
  }
  if (!fs.statSync(baseDir).isDirectory()) {
    sendJson(res, 400, { error: `baseDir is not a directory: ${baseDir}` });
    return;
  }
  sendJson(res, 201, sessionToJson(store.create(id, baseDir)));
}

/** `GET /api/sessions/:id`. */
function readSession({ res }: RouteContext, store: SessionStore, id: string): void {
  const session = store.get(id);
  if (!session) {
    sendNotFound(res);
    return;
  }
  sendJson(res, 200, sessionToJson(session));
}

/** `PATCH /api/sessions/:id` with `{ id }`: renames the session. The body is read first. */
async function renameSession(
  { req, res }: RouteContext,
  store: SessionStore,
  id: string,
): Promise<void> {
  const read = await readJsonOrReply(req, res);
  if (!read) return;
  const body = read.value as { id?: string };

  const session = store.get(id);
  if (!session) {
    sendNotFound(res);
    return;
  }
  const newId = body.id;
  if (!newId) {
    sendText(res, 400, 'missing id');
    return;
  }
  if (!isValidId(newId)) {
    sendJson(res, 400, { error: `invalid id: ${newId}` });
    return;
  }
  if (store.has(newId)) {
    sendJson(res, 409, { error: `session already exists: ${newId}` });
    return;
  }
  store.rename(id, newId);
  sendJson(res, 200, sessionToJson(session));
}

/** `DELETE /api/sessions/:id`: closes its sockets and shell; 204 with the sessions left. */
function deleteSession({ res }: RouteContext, store: SessionStore, id: string): void {
  const session = store.remove(id);
  if (!session) {
    sendNotFound(res);
    return;
  }
  session.close(WS_CLOSE.SESSION_GONE, 'session deleted');
  sendText(res, 204, undefined, { 'X-Sessions-Remaining': String(store.size) });
}
