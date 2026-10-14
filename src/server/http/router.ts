// A small ordered HTTP router: a list of (method, path, handler) routes where the first match
// wins, CORS on every response and a plain 404 when nothing matches (ADR 062). A utility; the
// webtty routes themselves are listed in routes/route-table.ts.
import type http from 'node:http';
import { sendNotFound, setCors } from './respond';

/** What a matched route's handler receives. */
export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The request path, without the query string. */
  pathname: string;
  /** The capture groups of a RegExp path, in order; empty for a string path. */
  params: string[];
}

/** One entry of the table: answers a request whose method and path match. */
export interface Route {
  /** An HTTP method such as `GET`, or `*` for any method. */
  method: string;
  /** An exact pathname, or a RegExp tested against the pathname (its groups become params). */
  path: string | RegExp;
  handle: (ctx: RouteContext) => void | Promise<void>;
}

/** Matches every pathname, for a route that applies to any path (the CORS preflight). */
export const ANY_PATH = /^/;

/** The first route in `routes` matching `method` and `pathname`, with its params, or null. */
export function matchRoute(
  routes: readonly Route[],
  method: string | undefined,
  pathname: string,
): { route: Route; params: string[] } | null {
  for (const route of routes) {
    if (route.method !== '*' && route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: [] };
      continue;
    }
    const m = pathname.match(route.path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}

/**
 * Builds the request handler for `routes`. The URL is parsed before anything is written (a
 * malformed Host header rejects with no headers set), then the CORS headers, then the first
 * matching route runs; with no match the reply is `404 Not Found`.
 */
export function createRouter(
  routes: readonly Route[],
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;
    setCors(res);
    const match = matchRoute(routes, req.method, pathname);
    if (!match) {
      sendNotFound(res);
      return;
    }
    await match.route.handle({ req, res, pathname, params: match.params });
  };
}
