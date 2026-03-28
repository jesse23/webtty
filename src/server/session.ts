import type { WebSocket as WS } from 'ws';
import type { PtyProcess } from '../pty';

/** A running (or recently created) terminal session. */
export interface Session {
  /** Unique session identifier. */
  id: string;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** The underlying PTY process, or `null` if no shell has been spawned yet. */
  pty: PtyProcess | null;
  /** All currently connected WebSocket clients for this session. */
  clients: Set<WS>;
  /** Accumulated PTY output retained for replay when a new client joins. */
  scrollback: string;
}

/** All active sessions, keyed by session ID. */
export const sessionRegistry = new Map<string, Session>();

/** ID of the most recently opened session, used for `GET /` redirect. */
export let lastUsedId: string | null = null;

/** Updates {@link lastUsedId}. */
export function setLastUsedId(id: string | null): void {
  lastUsedId = id;
}

const ID_RE = /^[a-z0-9\-_.]{1,64}$/;

/** Returns `true` if `id` is a valid session identifier (lowercase alphanumeric + `-_.`, max 64 chars). */
export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

/** Generates a random 8-character hex session ID. */
export function generateId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}

/** Creates a new session, registers it in {@link sessionRegistry}, and returns it. */
export function createSession(id: string): Session {
  const session: Session = {
    id,
    createdAt: Date.now(),
    pty: null,
    clients: new Set(),
    scrollback: '',
  };
  sessionRegistry.set(id, session);
  return session;
}

/** Returns a plain JSON-safe representation of a session for API responses. */
export function sessionToJson(s: Session) {
  return { id: s.id, createdAt: s.createdAt, connected: s.clients.size > 0 };
}
