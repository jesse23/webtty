// The CLI's one view of the webtty server's HTTP and WebSocket API: every request the commands
// make goes through a WebttyClient. A service over an injected fetch and WebSocket factory, so
// commands are tested against scripted responses instead of a live server (ADR 063).
import { loadConfig } from '../config';
import { LineSplitter } from '../ndjson';

/** The part of `fetch` the client calls; narrower than `typeof fetch` so a fake needs no casts. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The part of a WebSocket {@link WebttyClient.openPty} uses. */
export interface PtySocket {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(code?: number): void;
}

/** Opens a WebSocket to `url`; the global `WebSocket` in production. */
export type OpenSocket = (url: string) => PtySocket;

/** One row of `GET /api/sessions`. */
export interface SessionSummary {
  id: string;
  connected: boolean;
  createdAt: number;
}

/** One NDJSON line of `POST /s/:id/execute`: `{stream, data}`, or `{exit, error?}` last. */
export type ExecuteMessage = Record<string, unknown>;

/** What `ensureSession` found or made: the session id, or the server's reason it could not. */
export type EnsureSessionResult = { id: string } | { error: string };

/** What `DELETE /api/sessions/:id` answered: the status and `X-Sessions-Remaining`. */
export interface RemoveSessionResult {
  status: number;
  sessionsRemaining: string | null;
}

/** What `PATCH /api/sessions/:id` answered. */
export interface RenameSessionResult {
  status: number;
  ok: boolean;
  /** Reads the body's `error` field; call it only for a status that carries one. */
  error(): Promise<string | undefined>;
}

/** The status line of `POST /s/:id/execute` and, when it has a body, its messages in order. */
export interface ExecuteResponse {
  status: number;
  ok: boolean;
  /** Null when the response has no body. Iterating throws on a line that is not JSON. */
  messages: AsyncIterable<ExecuteMessage> | null;
}

/**
 * Thrown when the server cannot be reached at all (the request never got a response), so a
 * command can tell "webtty is not running" apart from a bad answer.
 */
export class ServerUnreachableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ServerUnreachableError';
  }
}

/** The loopback base URL for `port`: always 127.0.0.1, which avoids an IPv6 lookup. */
export function localBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The client for the configured server. The config file is read on every request, as the CLI
 * always has, so a bad config file surfaces as "not running" where the old calls caught it.
 */
export function configuredClient(): WebttyClient {
  return new WebttyClient(() => localBaseUrl(loadConfig().port));
}

/** Calls the webtty server's API. One instance per CLI invocation. */
export class WebttyClient {
  private readonly baseUrl: () => string;

  /**
   * @param baseUrl - The server's base URL, or a function read on every request.
   * @param fetchFn - The HTTP call; the global `fetch` (looked up per call) by default.
   * @param openSocket - The WebSocket factory; the global `WebSocket` by default.
   */
  constructor(
    baseUrl: string | (() => string),
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly openSocket: OpenSocket = (url) => new WebSocket(url),
  ) {
    this.baseUrl = typeof baseUrl === 'string' ? () => baseUrl : baseUrl;
  }

  /** True when `GET /api/sessions` answers 2xx with a JSON array; false on any failure. */
  async isRunning(): Promise<boolean> {
    try {
      const res = await this.send('/api/sessions');
      if (!res.ok) return false;
      return Array.isArray(await res.json());
    } catch {
      return false;
    }
  }

  /** All sessions. Throws {@link ServerUnreachableError} when the server does not answer. */
  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.send('/api/sessions');
    return (await res.json()) as SessionSummary[];
  }

  /**
   * Returns session `id` if it exists, otherwise creates it (in `baseDir` when given). The one
   * copy of ensure-or-create, shared by `go` and `run`'s warm-up.
   */
  async ensureSession(id: string, baseDir?: string): Promise<EnsureSessionResult> {
    const check = await this.send(`/api/sessions/${encodeURIComponent(id)}`);
    if (check.status === 200) return { id };
    const res = await this.send(
      '/api/sessions',
      jsonRequest('POST', { id, ...(baseDir ? { baseDir } : {}) }),
    );
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      return { error: body.error ?? `failed to create session (${res.status})` };
    }
    const session = (await res.json()) as { id: string };
    return { id: session.id };
  }

  /** `DELETE /api/sessions/:id`. */
  async removeSession(id: string): Promise<RemoveSessionResult> {
    const res = await this.send(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { status: res.status, sessionsRemaining: res.headers.get('x-sessions-remaining') };
  }

  /** `PATCH /api/sessions/:id` with the new id. */
  async renameSession(id: string, newId: string): Promise<RenameSessionResult> {
    const res = await this.send(
      `/api/sessions/${encodeURIComponent(id)}`,
      jsonRequest('PATCH', { id: newId }),
    );
    return {
      status: res.status,
      ok: res.ok,
      error: async () => ((await res.json()) as { error?: string }).error,
    };
  }

  /** `POST /api/server/stop`; true when the server accepted. */
  async stop(): Promise<boolean> {
    const res = await this.send('/api/server/stop', { method: 'POST' });
    return res.ok;
  }

  /** `POST /s/:id/execute`, with the NDJSON body as an async iterator of messages. */
  async execute(id: string, cmd: string, args: string[]): Promise<ExecuteResponse> {
    const res = await this.send(
      `/s/${encodeURIComponent(id)}/execute`,
      jsonRequest('POST', { cmd, args }),
    );
    return { status: res.status, ok: res.ok, messages: res.body ? ndjsonMessages(res.body) : null };
  }

  /**
   * Opens session `id`'s PTY socket at 80x24, which starts the PTY, then closes it. Rejects with
   * the reason when the socket errors or closes before it opened.
   */
  openPty(id: string): Promise<void> {
    const url = `${this.baseUrl().replace(/^http/, 'ws')}/ws/${encodeURIComponent(id)}/pty?cols=80&rows=24`;
    return new Promise<void>((resolve, reject) => {
      const ws = this.openSocket(url);
      let opened = false;
      ws.onopen = () => {
        opened = true;
        ws.close(1000);
        resolve();
      };
      ws.onerror = () => reject(new Error('failed to connect to PTY'));
      ws.onclose = (evt) => {
        if (!opened) reject(new Error(`failed to start PTY (code ${evt.code})`));
      };
    });
  }

  /** One request; any failure before a response becomes a {@link ServerUnreachableError}. */
  private async send(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(`${this.baseUrl()}${path}`, init);
    } catch (err) {
      throw new ServerUnreachableError(err);
    }
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** The messages of an NDJSON body, one per line, parsed as they arrive. */
async function* ndjsonMessages(body: ReadableStream<Uint8Array>): AsyncIterable<ExecuteMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // The server never sends CR; keeping it leaves the lines exactly as they were before the splitter.
  const lines = new LineSplitter({ stripCarriageReturn: false });
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const line of lines.push(decoder.decode(value, { stream: true }))) {
      yield JSON.parse(line) as ExecuteMessage;
    }
  }
}
