// Test helper: a fetch that answers from a route table and records every request, and a fake
// PTY socket, so WebttyClient and the commands run without a server (ADR 063, ADR 064).
import type { FetchLike, OpenSocket, PtySocket } from '../api-client';

/** The base URL the fakes pretend to serve. */
export const FAKE_BASE_URL = 'http://127.0.0.1:7681';

/** One request the fake fetch received; `body` is the parsed JSON body, if any. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/** Answers one request; throwing simulates a server that cannot be reached. */
export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * A fetch over a route table keyed by `"METHOD /path"`. A request with no route fails the test
 * with a thrown Error, which the client reports as unreachable, so assert on `requests` too.
 */
export function scriptedFetch(routes: Record<string, Responder>) {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.slice(FAKE_BASE_URL.length),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    requests.push(request);
    const respond = routes[`${request.method} ${request.path}`];
    if (!respond) throw new Error(`no route for ${request.method} ${request.path}`);
    return respond(request);
  };
  return { fetchFn, requests };
}

/** A responder for a server that is down: fetch rejects as it does on ECONNREFUSED. */
export const refused: Responder = () => {
  throw new TypeError('fetch failed');
};

/** A JSON response. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** An NDJSON response streaming `chunks` as given, so a test controls the line splits. */
export function ndjson(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

/** One NDJSON line per message. */
export function lines(...messages: unknown[]): string {
  return messages.map((m) => `${JSON.stringify(m)}\n`).join('');
}

/** How a fake PTY socket behaves once created. */
export type SocketBehaviour = 'open' | 'error' | 'close-without-open';

/** A socket factory whose sockets open, error or close with 1006, recording the URLs. */
export function fakeSockets(behaviour: SocketBehaviour = 'open') {
  const urls: string[] = [];
  const closeCodes: Array<number | undefined> = [];
  const openSocket: OpenSocket = (url) => {
    urls.push(url);
    const socket: PtySocket = {
      onopen: null,
      onerror: null,
      onclose: null,
      close(code) {
        closeCodes.push(code);
        queueMicrotask(() => socket.onclose?.(new CloseEvent('close', { code: 1000 })));
      },
    };
    queueMicrotask(() => {
      if (behaviour === 'open') socket.onopen?.(new Event('open'));
      else if (behaviour === 'error') socket.onerror?.(new Event('error'));
      else socket.onclose?.(new CloseEvent('close', { code: 1006 }));
    });
    return socket;
  };
  return { openSocket, urls, closeCodes };
}
