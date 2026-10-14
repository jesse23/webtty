// SessionStore: the server's one registry of sessions, keyed by ID, plus the last-used
// ID that `GET /` redirects to (ADR 062). An object created once in index.ts and passed
// to the routes and the WebSocket server instead of a module-global Map.
import { newSession, type Session } from '../session';

/** What the store needs from its owner: who to tell once the last session has gone. */
export interface SessionStoreOptions {
  /** Called by {@link SessionStore.notifyIfEmpty} when no session is left (stops the server). */
  onEmpty?: () => void;
}

/** Owns every live session so routes and sockets share one registry that tests can build fresh. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly onEmpty: (() => void) | undefined;
  private lastUsed: string | null = null;

  constructor(options: SessionStoreOptions = {}) {
    this.onEmpty = options.onEmpty;
  }

  /** The ID of the session a client attached to most recently, for the `GET /` redirect. */
  get lastUsedId(): string | null {
    return this.lastUsed;
  }

  /** The number of registered sessions (the `X-Sessions-Remaining` header). */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Creates a session and registers it under `id`. Callers check {@link has} first and
   * answer 409 themselves.
   *
   * @param id - The session ID.
   * @param baseDir - Working directory for the PTY shell (default: the user's home).
   * @returns The new session.
   */
  create(id: string, baseDir?: string): Session {
    const session = newSession(id, baseDir);
    this.sessions.set(id, session);
    return session;
  }

  /** Looks a session up by ID. */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Whether a session is registered under `id`. */
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Every session in creation order, for `GET /api/sessions` and shutdown. */
  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** The first session whose PTY has process ID `pid`, for the `/p/:pid` redirect. */
  findByPid(pid: number): Session | undefined {
    return this.list().find((s) => s.pty?.pid === pid);
  }

  /** Records `id` as the last-used session; a client has just attached to it. */
  markUsed(id: string): void {
    this.lastUsed = id;
  }

  /**
   * Re-registers the session `id` under `newId` and updates its `id` field. The last-used
   * ID follows the rename. The caller has already checked that `newId` is free.
   *
   * @returns The renamed session, or `undefined` if `id` is not registered.
   */
  rename(id: string, newId: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    session.id = newId;
    this.sessions.set(newId, session);
    if (this.lastUsed === id) this.lastUsed = newId;
    return session;
  }

  /**
   * Unregisters a session deleted through the API and forgets it as the last-used one.
   *
   * @returns The removed session, or `undefined` if `id` is not registered.
   */
  remove(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    this.sessions.delete(id);
    if (this.lastUsed === id) this.lastUsed = null;
    return session;
  }

  /**
   * Unregisters a session whose shell exited. Unlike {@link remove} the last-used ID is
   * kept, as it always was: `GET /` skips an ID that is no longer registered, and still
   * returns to it if a session of the same name is created again.
   */
  removeExited(id: string): void {
    this.sessions.delete(id);
  }

  /** Calls `onEmpty` if no session is left; the PTY exit path calls this after its flush. */
  notifyIfEmpty(): void {
    if (this.sessions.size === 0) this.onEmpty?.();
  }
}
