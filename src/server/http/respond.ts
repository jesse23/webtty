// Response writers for the HTTP routes: CORS, JSON, plain text and redirects (ADR 062).
// Utilities; each writes the status line and headers exactly as the old inline code did.
import type http from 'node:http';

/** The CORS headers set on every response, errors and 404s included. */
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Sets {@link CORS_HEADERS} on `res`, before any route writes its head. */
export function setCors(res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

/** Ends `res` with `status` and `value` as a JSON body. */
export function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

/**
 * Ends `res` with `status`, optional extra headers and an optional body. With no body it
 * calls `res.end()` with no argument, as the routes always have, so no header changes.
 */
export function sendText(
  res: http.ServerResponse,
  status: number,
  body?: string,
  headers?: http.OutgoingHttpHeaders,
): void {
  if (headers) res.writeHead(status, headers);
  else res.writeHead(status);
  if (body === undefined) res.end();
  else res.end(body);
}

/** The plain `404 Not Found` every unmatched or missing resource ends in. */
export function sendNotFound(res: http.ServerResponse): void {
  sendText(res, 404, 'Not Found');
}

/** The plain `400 Bad Request` for an undecodable ID or a wrong content type. */
export function sendBadRequest(res: http.ServerResponse): void {
  sendText(res, 400, 'Bad Request');
}

/** A `302` to `location` with an empty body. */
export function redirect(res: http.ServerResponse, location: string): void {
  sendText(res, 302, undefined, { Location: location });
}
