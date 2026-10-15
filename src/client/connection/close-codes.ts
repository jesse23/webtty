// The WebSocket close codes the client acts on (constants, ADR 060). They mirror the
// server's own codes; close-codes.test.ts pins them to the server's values.

/** The close codes the server ends a PTY socket with, by what each one means to the tab. */
export const CLOSE_CODE = {
  /** RFC 6455 "going away": the server is stopping. */
  SERVER_STOPPED: 1001,
  /** The session was removed or its shell exited. */
  SESSION_GONE: 4001,
  /** The tab fell too far behind the output and was dropped (ADR 048). */
  FELL_BEHIND: 4003,
} as const;
