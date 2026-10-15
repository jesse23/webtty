// The handler for a terminal client (`/ws/:id/pty`): attaches the socket to its Session,
// which spawns the shell or replays the scrollback, then routes the client's messages to
// the pacer or the PTY. A handler function over a narrow socket interface, so tests pass a
// fake (ADR 062, ADR 048).
import type { FlowSocket } from '../output-pacer';
import type { PtySpawnDeps } from '../sessions/session';
import type { SessionStore } from '../sessions/session-store';
import { parseClientMessage, sizeFromQuery } from './client-message';
import { WS_CLOSE } from './close-codes';

/** The part of a WebSocket a terminal client uses. */
export interface PtyClientSocket extends FlowSocket {
  on(event: 'message', listener: (data: Buffer) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

/**
 * Attaches `ws` to the session `id`, or closes it with SESSION_GONE if there is none. The
 * order is fixed (ADR 062): the client joins the pacer, the session is marked last-used, and
 * only then is the shell spawned (banner, then `\n`) or the scrollback replayed (then resize).
 *
 * @param store - The server's sessions; also told when the shell exits.
 * @param ws - The client's socket.
 * @param id - The decoded session ID from the URL.
 * @param params - The URL's query: `cols`, `rows` and `flow=1`.
 * @param deps - How to read the config and spawn the shell.
 */
export function handlePtySocket(
  store: SessionStore,
  ws: PtyClientSocket,
  id: string,
  params: URLSearchParams,
  deps: PtySpawnDeps,
): void {
  const { cols, rows } = sizeFromQuery(params);
  const session = store.get(id);
  if (!session) {
    ws.close(WS_CLOSE.SESSION_GONE, 'session deleted');
    return;
  }
  session.attach(ws, params.get('flow') === '1');
  store.markUsed(id);
  session.ensurePty(ws, cols, rows, deps, store);

  ws.on('message', (data: Buffer) => {
    const message = data.toString('utf8');
    const msg = parseClientMessage(message);
    try {
      if (msg.type === 'ack') {
        session.output.ack(ws, msg.chars);
        return;
      }
      if (msg.type === 'resize') {
        session.pty?.resize(msg.cols, msg.rows);
        return;
      }
    } catch {
      // A control message whose handling throws (node-pty refuses to resize a PTY that
      // has exited) is written to the PTY as raw input, as it always has been.
    }
    session.pty?.write(message);
  });

  ws.on('close', () => {
    session.detach(ws);
  });

  ws.on('error', () => {});
}
