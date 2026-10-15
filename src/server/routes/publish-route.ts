// `POST /s/:id/publish`: an NDJSON request body, each valid JSON line broadcast to the
// session's event subscribers (ADR 062). A route handler built on the shared LineSplitter.
import { LineSplitter } from '../../ndjson';
import { MAX_BODY } from '../http/request-body';
import { sendText } from '../http/respond';
import type { Route } from '../http/router';
import type { SessionStore } from '../sessions/session-store';
import { runningSessionOrReply } from './running-session';

/** What the publish route needs. */
export interface PublishRouteDeps {
  store: SessionStore;
}

/** The publish route; it answers 204 once the request body ends. */
export function publishRoutes(deps: PublishRouteDeps): Route[] {
  return [
    {
      method: 'POST',
      path: /^\/s\/([^/]+)\/publish$/,
      handle: ({ req, res, params }) => {
        const session = runningSessionOrReply(req, res, deps.store, params[0]);
        if (!session) return;
        // One event per NDJSON line; invalid JSON lines are skipped, and a line that grows
        // past 64 KB without a newline is dropped.
        const broadcastIfJson = (line: string) => {
          try {
            JSON.parse(line);
            session.broadcastEvent(line);
          } catch {
            // skip invalid JSON lines
          }
        };
        const lines = new LineSplitter({ maxLength: MAX_BODY });
        req.on('data', (chunk: Buffer) => {
          for (const line of lines.push(chunk.toString('utf8'))) broadcastIfJson(line);
        });
        req.on('end', () => {
          const last = lines.flush();
          if (last) broadcastIfJson(last);
          sendText(res, 204);
        });
        req.on('error', () => {
          sendText(res, 500);
        });
      },
    },
  ];
}
