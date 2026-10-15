// The handler for an event subscriber (`/ws/:id/events`): the socket `webtty` tools use to
// receive lines published to a session. A handler function over a narrow socket interface,
// so tests pass a fake (ADR 062).
import type { FlowSocket } from '../output-pacer';
import type { SessionStore } from '../sessions/session-store';
import { WS_CLOSE } from './close-codes';

/** The part of a WebSocket an event subscriber uses. */
export interface EventsSocket extends FlowSocket {
  on(event: 'close' | 'error', listener: () => void): unknown;
}

/**
 * Subscribes `ws` to the session `id`'s events. A session that does not exist closes it with
 * SESSION_GONE, and one whose shell is not running with PTY_NOT_RUNNING.
 *
 * @param store - The server's sessions.
 * @param ws - The subscriber's socket.
 * @param id - The decoded session ID from the URL.
 */
export function handleEventsSocket(store: SessionStore, ws: EventsSocket, id: string): void {
  const session = store.get(id);
  if (!session) {
    ws.close(WS_CLOSE.SESSION_GONE, 'session deleted');
    return;
  }
  if (session.pty === null) {
    ws.close(WS_CLOSE.PTY_NOT_RUNNING, 'PTY not running');
    return;
  }
  session.subscribers.add(ws);
  ws.on('close', () => {
    session.subscribers.delete(ws);
  });
  ws.on('error', () => {});
}
