// The WebSocket close codes the server sends (ADR 048, ADR 062). Constants only; the
// client mirrors the ones it acts on and a contract test pins the two together.
import { FELL_BEHIND } from '../output-pacer';

/** Close codes by meaning, so call sites say why a socket closed rather than a number. */
export const WS_CLOSE = {
  SERVER_STOPPED: 1001 as const, // RFC 6455: server going away
  BAD_REQUEST: 1008 as const, // RFC 6455: policy violation / bad data
  SESSION_GONE: 4001 as const, // app-level: session deleted or shell exited
  PTY_NOT_RUNNING: 4002 as const, // app-level: PTY not running
  FELL_BEHIND, // app-level: client fell too far behind the output (ADR 048)
} as const;
