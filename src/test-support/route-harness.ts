// The whole server in-process for the route golden tests: createServer on port 0 with a
// temporary HOME and dist, a fresh server and SessionStore per test, and helpers that read a
// reply as status, headers and body. A test-support object, never collected as a test (ADR 062, ADR 064).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Session } from '../server/sessions/session';
import type { SessionStore } from '../server/sessions/session-store';
import { FakePty } from './fake-pty';
import { type LiveServer, startLiveServer } from './live-server';
import { type TmpHome, useTmpHome } from './server-harness';

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
  private home: TmpHome | null = null;
  private distDir = '';
  private current: LiveServer | null = null;

  /** The running server; reset() replaces it so each test starts with no sessions. */
  get live(): LiveServer {
    if (!this.current) throw new Error('RouteHarness: call reset() before using the server');
    return this.current;
  }

  /** The sessions the routes see. */
  get store(): SessionStore {
    return this.live.store;
  }

  /** How many times the server called onStop. */
  get stops(): number {
    return this.live.stops();
  }

  /** Makes the temporary HOME, dist and wasm the servers serve. */
  async start(): Promise<void> {
    this.home = useTmpHome('routes-golden');
    this.tmpHome = this.home.dir;
    this.distDir = path.join(this.tmpHome, 'dist');
    fs.mkdirSync(this.distDir);
    fs.writeFileSync(path.join(this.distDir, 'client.html'), CLIENT_HTML);
    fs.writeFileSync(path.join(this.distDir, 'client-browser.js'), 'console.log(1);');
    fs.writeFileSync(path.join(this.distDir, 'client.css'), 'body{}');
    this.wasmPath = path.join(this.tmpHome, 'ghostty-vt-small.wasm');
    fs.writeFileSync(this.wasmPath, WASM_BYTES);
    fs.writeFileSync(path.join(this.tmpHome, 'secret.txt'), 'secret');
  }

  /** Gives the next test a new server: an empty store, no stop calls and no config file. */
  async reset(): Promise<void> {
    this.current?.close();
    fs.rmSync(path.join(this.tmpHome, '.config'), { recursive: true, force: true });
    this.current = await startLiveServer({
      paths: { projectRoot: this.tmpHome, clientRoot: this.distDir, wasmPath: this.wasmPath },
      spawnPty: () => new FakePty(),
    });
  }

  /** Closes the server, restores HOME and removes the temporary directory. */
  async stop(): Promise<void> {
    this.current?.close();
    this.current = null;
    this.home?.restore();
  }

  /** Writes `config` as the config file in the temporary HOME; the handler reads it per request. */
  writeConfig(config: object): void {
    const dir = path.join(this.tmpHome, '.config', 'webtty');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }

  /** Sends a request without following redirects; the reply's headers leave out Date. */
  call = async (method: string, url: string, init: RequestInit = {}): Promise<Reply> => {
    const res = await fetch(`${this.live.base}${url}`, { method, redirect: 'manual', ...init });
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
    const response = fetch(`${this.live.base}${url}`, init as RequestInit);
    return { controller, response };
  };

  /** GETs `rawPath` with node:http, so a path like `/dist/../x` reaches the server unnormalised. */
  rawGet = (rawPath: string): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const req = http.request(`${this.live.base}/`, { path: rawPath }, (res) => {
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
