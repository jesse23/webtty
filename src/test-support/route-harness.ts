// An in-process HTTP server for the route golden tests: the request handler on a free loopback
// port with a temporary HOME and dist, a fresh SessionStore per test, and helpers that read a
// reply as status, headers and body. A test-support object, never collected as a test (ADR 062, ADR 064).
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadConfig } from '../config';
import { createRequestHandler } from '../server/routes/route-table';
import type { Session } from '../server/sessions/session';
import { SessionStore } from '../server/sessions/session-store';
import { FakePty } from './fake-pty';
import { cleanupTmpHome, getFreePort, makeTmpHome } from './server-harness';

/** A reply reduced to what the golden tests pin. */
export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The CORS headers every response carries, 404s and errors included. */
export const CORS = {
  'access-control-allow-headers': 'Content-Type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-origin': '*',
};

/** Headers of a `res.end(text)` reply with no Content-Type; Bun's node:http sends Content-Length: 0 on a 204 too. */
export const plain = (length: number) => ({ ...CORS, 'content-length': String(length) });

/** Headers of a JSON reply whose body is `body`. */
export const json = (body: string) => ({
  ...plain(Buffer.byteLength(body)),
  'content-type': 'application/json',
});

/** Headers of the streamed NDJSON reply from `/s/:id/execute`. */
export const NDJSON = {
  ...CORS,
  'cache-control': 'no-cache',
  'content-type': 'application/x-ndjson',
  'transfer-encoding': 'chunked',
};

/** The reply every unmatched route ends in. */
export const NOT_FOUND: Reply = { status: 404, headers: plain(9), body: 'Not Found' };

/** The reply to an undecodable ID or a wrong content type. */
export const BAD_REQUEST: Reply = { status: 400, headers: plain(11), body: 'Bad Request' };

/** The page `/s/:id` serves from the temporary dist. */
export const CLIENT_HTML = '<!doctype html><p>client</p>';

/** The bytes of the stand-in wasm. */
export const WASM_BYTES = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

/** Keeps the server and its temporary HOME; call start() in beforeAll, reset() in beforeEach, stop() in afterAll. */
export class RouteHarness {
  tmpHome = '';
  wasmPath = '';
  /** The sessions the handler sees; replaced by reset() so tests start empty. */
  store = new SessionStore();
  /** How many times the handler called onStop. */
  stops = 0;
  private server: http.Server | null = null;
  private baseUrl = '';
  private origHome: string | undefined;

  /** Makes the temporary HOME, dist and wasm, and listens on a free port, wrapped as src/server/index.ts wraps the handler. */
  async start(): Promise<void> {
    this.origHome = process.env.HOME;
    this.tmpHome = makeTmpHome('routes-golden');
    process.env.HOME = this.tmpHome;
    const distDir = path.join(this.tmpHome, 'dist');
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'client.html'), CLIENT_HTML);
    fs.writeFileSync(path.join(distDir, 'client-browser.js'), 'console.log(1);');
    fs.writeFileSync(path.join(distDir, 'client.css'), 'body{}');
    this.wasmPath = path.join(this.tmpHome, 'ghostty-vt-small.wasm');
    fs.writeFileSync(this.wasmPath, WASM_BYTES);
    fs.writeFileSync(path.join(this.tmpHome, 'secret.txt'), 'secret');

    const server = http.createServer((req, res) => {
      // Built per request so a store replaced by reset() is the one the routes see.
      const handleRequest = createRequestHandler({
        store: this.store,
        loadConfig,
        wasmPath: this.wasmPath,
        clientDistPath: distDir,
        onStop: () => this.stops++,
      });
      handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      });
    });
    const port = await getFreePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    this.server = server;
  }

  /** Gives the next test an empty store, no stop calls and no config file. */
  reset(): void {
    this.store = new SessionStore();
    this.stops = 0;
    fs.rmSync(path.join(this.tmpHome, '.config'), { recursive: true, force: true });
  }

  /** Closes the server, restores HOME and removes the temporary directory. */
  async stop(): Promise<void> {
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
    if (this.origHome === undefined) delete process.env.HOME;
    else process.env.HOME = this.origHome;
    cleanupTmpHome(this.tmpHome);
  }

  /** Writes `config` as the config file in the temporary HOME; the handler reads it per request. */
  writeConfig(config: object): void {
    const dir = path.join(this.tmpHome, '.config', 'webtty');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }

  /** Sends a request without following redirects; the reply's headers leave out Date. */
  call = async (method: string, url: string, init: RequestInit = {}): Promise<Reply> => {
    const res = await fetch(`${this.baseUrl}${url}`, { method, redirect: 'manual', ...init });
    const headers: Record<string, string> = {};
    for (const [k, v] of res.headers) {
      if (k !== 'date' && k !== 'connection' && k !== 'keep-alive') headers[k] = v;
    }
    return { status: res.status, headers, body: await res.text() };
  };

  /** POSTs `body` (an object is JSON-encoded, a string is sent as-is) with `contentType`. */
  post = (url: string, body: unknown, contentType = 'application/json'): Promise<Reply> =>
    this.call('POST', url, {
      headers: { 'content-type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  /** POSTs a streamed body; the test pushes chunks into the returned controller and closes it. */
  postStream = (url: string) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    };
    const response = fetch(`${this.baseUrl}${url}`, init as RequestInit);
    return { controller, response };
  };

  /** GETs `rawPath` with node:http, so a path like `/dist/../x` reaches the server unnormalised. */
  rawGet = (rawPath: string): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(`${this.baseUrl}/`, { path: rawPath }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => {
          body += c.toString();
        });
        res.on('end', () => {
          const headers = res.headers as Record<string, string>;
          resolve({ status: res.statusCode ?? 0, headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });

  /** Registers a session whose PTY is a fake, as if a client had spawned its shell. */
  running = (id: string, pid = 4242, log: string[] = []): Session => {
    const session = this.store.create(id, this.tmpHome);
    session.pty = new FakePty(log, pid);
    return session;
  };

  /** Registers a session with no shell yet. */
  idle = (id: string): Session => this.store.create(id, this.tmpHome);
}

/** The JSON body sessionToJson gives a session with no client, written out field by field. */
export function sessionBody(s: Session): string {
  return JSON.stringify({
    id: s.id,
    createdAt: s.createdAt,
    baseDir: s.baseDir,
    connected: false,
    pid: s.pty?.pid ?? null,
  });
}

/** Polls `cond` every 5 ms for up to 2 s. */
export async function until(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await Bun.sleep(5);
  }
}
