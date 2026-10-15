// The checks `/s/:id/publish` and `/s/:id/execute` share before touching a session: a
// decodable ID, a JSON content type, a known session and a running shell (ADR 062). A utility.
import type http from 'node:http';
import { decodeId, hasJsonContentType } from '../http/request-body';
import { sendBadRequest, sendNotFound, sendText } from '../http/respond';
import type { Session } from '../sessions/session';
import type { SessionStore } from '../sessions/session-store';

/**
 * The session named by the raw path segment `rawId` if its shell is running. Otherwise it has
 * answered `res` (400 bad ID or content type, 404 unknown session, 409 no PTY) and returns null.
 */
export function runningSessionOrReply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: SessionStore,
  rawId: string,
): Session | null {
  const id = decodeId(rawId);
  if (!id || !hasJsonContentType(req)) {
    sendBadRequest(res);
    return null;
  }
  const session = store.get(id);
  if (!session) {
    sendNotFound(res);
    return null;
  }
  if (session.pty === null) {
    sendText(res, 409, 'PTY not running');
    return null;
  }
  return session;
}
