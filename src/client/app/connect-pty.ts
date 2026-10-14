// Step 7 of the client root (wiring, ADR 048, ADR 060): the PTY connection and what runs
// around a socket's creation, open, output and close. Kept apart from start-client.ts so
// the on-open sequence and the per-message order are tested on their own.

import { OutputAck } from '../connection/output-ack';
import { createOutputHandler, type OutputPipelineParts } from '../connection/output-pipeline';
import { PtyConnection } from '../connection/pty-connection';
import type { Terminal } from '../vendor/ghostty-web';
import type { ClientEnv } from './browser-env';

/** The terminal as the connection's host uses it. */
export type PtyTerminal = Pick<Terminal, 'cols' | 'rows' | 'resyncFocus' | 'write' | 'reset'>;

/** The globals the connection uses. */
export type PtyEnv = Pick<
  ClientEnv,
  'window' | 'WebSocket' | 'setTimeout' | 'clearTimeout' | 'performance'
>;

/** The parts of other steps the connection calls into, as structural slices. */
export interface PtyParts {
  /** ReplayWindow: told of each new socket, then fed the output (ADR 053). */
  replay: OutputPipelineParts['replay'] & { connected(): void };
  /** Kitty graphics: fed the output, and started over on every open (ADR 032). */
  graphics: OutputPipelineParts['graphics'] & { reset(): void };
  smoothScroll: OutputPipelineParts['smoothScroll'];
  /** The clipboard feature's `connected()`: hold OSC 52 writes until input (ADR 052). */
  connected(): void;
}

/** Builds the session's PTY connection and starts connecting. */
export function connectPty(
  sessionId: string,
  term: PtyTerminal,
  env: PtyEnv,
  parts: PtyParts,
): PtyConnection {
  const { replay, graphics, smoothScroll } = parts;
  const connection = new PtyConnection(
    sessionId,
    {
      size: () => ({ cols: term.cols, rows: term.rows }),
      created: () => {
        // The output starts with the session's replay: hold OSC 52 writes until input
        // (ADR 052), and ignore its bells and notifications until its last piece (ADR 053,
        // ADR 056)
        parts.connected();
        replay.connected();
      },
      opening: () => graphics.reset(),
      // Focus changes while the socket was down were dropped: send the state the app's
      // mode 1004 now misses (ADR 053). After a reset the mode is off until the replay.
      opened: () => term.resyncFocus(),
      output: createOutputHandler({
        replay,
        graphics,
        smoothScroll,
        now: () => env.performance.now(),
      }),
      write: (data) => term.write(data),
      reset: () => term.reset(),
      closeWindow: () => env.window.close(),
    },
    {
      ...env,
      location: env.window.location,
      // Each socket's own ack, on the env's clock (ADR 048)
      createAck: (send) =>
        new OutputAck(send, {
          set: (fn, ms) => env.setTimeout(fn, ms),
          clear: (handle) => env.clearTimeout(handle as number),
        }),
    },
  );
  connection.connect();
  return connection;
}
