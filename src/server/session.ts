import type { WebSocket as WS } from 'ws';
import type { PtyProcess } from '../pty';

export const SCROLLBACK_MAX = 256 * 1024;

export interface Session {
  id: string;
  createdAt: number;
  pty: PtyProcess | null;
  clients: Set<WS>;
  scrollback: string;
}

export const sessionRegistry = new Map<string, Session>();
export let lastUsedId: string | null = null;

export function setLastUsedId(id: string | null): void {
  lastUsedId = id;
}

const ID_RE = /^[a-z0-9\-_.]{1,64}$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function generateId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
}

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

export function sessionToJson(s: Session) {
  return { id: s.id, createdAt: s.createdAt, connected: s.clients.size > 0 };
}
