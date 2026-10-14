// The Session record: one terminal session's PTY, clients, subscribers, scrollback and
// output pacer, plus its JSON view for the API. Types and pure factories; the registry
// of sessions is SessionStore in sessions/session-store.ts (ADR 062).
import { homedir } from 'node:os';
import type { WebSocket as WS } from 'ws';
import type { PtyProcess } from '../pty';
import { OutputPacer } from './output-pacer';

/** A running (or recently created) terminal session. */
export interface Session {
  /** Unique session identifier. */
  id: string;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Working directory for the PTY shell. */
  baseDir: string;
  /** The underlying PTY process, or `null` if no shell has been spawned yet. */
  pty: PtyProcess | null;
  /** All currently connected WebSocket clients for this session. */
  clients: Set<WS>;
  /** All currently connected event subscribers for this session. */
  subscribers: Set<WS>;
  /** Accumulated PTY output retained for replay when a new client joins. */
  scrollback: string;
  /** Paces PTY output to the clients by their acknowledgements (ADR 048). */
  output: OutputPacer;
}

/**
 * Builds a session that has no shell yet; `SessionStore.create` registers it.
 *
 * @param id - The session ID.
 * @param baseDir - Working directory for the PTY shell (default: `homedir()`).
 * @returns The new, unregistered {@link Session}.
 */
export function newSession(id: string, baseDir = homedir()): Session {
  const session: Session = {
    id,
    createdAt: Date.now(),
    baseDir,
    pty: null,
    clients: new Set(),
    subscribers: new Set(),
    scrollback: '',
    output: new OutputPacer(() => session.pty),
  };
  return session;
}

/**
 * Returns a plain JSON-safe representation of a session for API responses.
 *
 * @param s - The session to serialize.
 * @returns A JSON-safe object with session ID, creation timestamp, connection status, and PTY PID (or `null` if no PTY has been spawned yet).
 */
export function sessionToJson(s: Session) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    baseDir: s.baseDir,
    connected: s.clients.size > 0,
    pid: s.pty?.pid ?? null,
  };
}
