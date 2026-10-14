// Request-side helpers for the HTTP routes: the 64 KB JSON body reader with its single
// 413/400 error mapping, the JSON content-type check and URL ID decoding (ADR 062). Utilities.
import type http from 'node:http';
import { sendText } from './respond';

/** The largest request body the server reads, JSON or an NDJSON line (64 KB). */
export const MAX_BODY = 64 * 1024;

/**
 * Reads and JSON-parses the request body (max 64 KB).
 *
 * @param req - The incoming HTTP request.
 * @returns A promise resolving to the parsed JSON value, or an empty object if the body is empty.
 * @throws {Error} with `status: 413` if the body exceeds 64 KB (the request is destroyed).
 * @throws {Error} if the body contains invalid JSON.
 */
export function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** The status and body a {@link readJson} failure is answered with: 413 when too large, else 400. */
export function bodyErrorReply(err: unknown): { status: 413 | 400; body: string } {
  return (err as { status?: number }).status === 413
    ? { status: 413, body: 'Payload Too Large' }
    : { status: 400, body: 'invalid JSON' };
}

/**
 * Reads the JSON body of `req` for a route. On failure it has already answered `res`
 * (413 or 400, see {@link bodyErrorReply}) and returns null; otherwise `{ value }`.
 */
export async function readJsonOrReply(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<{ value: unknown } | null> {
  try {
    return { value: await readJson(req) };
  } catch (err) {
    const reply = bodyErrorReply(err);
    sendText(res, reply.status, reply.body);
    return null;
  }
}

/** True when the request says its body is JSON, as /publish and /execute require. */
export function hasJsonContentType(req: http.IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').startsWith('application/json');
}

/** Decodes a percent-encoded ID from a URL path segment, or null if it is malformed. */
export function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
