// What a PTY client sends the server: the size in its ws URL and the messages on the
// socket (ADR 048, ADR 062). Pure parsing only; pty-socket.ts applies the result.

/** Default terminal size when the client sends none, or a non-number. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 1000;
const MAX_ROWS = 500;

/** A terminal size in cells. */
export interface TermSize {
  cols: number;
  rows: number;
}

/**
 * One message from a PTY client: an output acknowledgement (ADR 048), a resize, or raw
 * keyboard input for the shell.
 */
export type ClientMessage =
  | { type: 'ack'; chars: number }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'input'; data: string };

/**
 * Clamps a requested size to 1..1000 columns and 1..500 rows, so a bad client can never
 * hand the PTY a zero or absurd size. 0 and NaN fall back to 80×24.
 *
 * @param cols - Requested columns, already an integer or NaN.
 * @param rows - Requested rows, already an integer or NaN.
 * @returns The size to give the PTY.
 */
export function clampSize(cols: number, rows: number): TermSize {
  return {
    cols: Math.max(1, Math.min(MAX_COLS, cols || DEFAULT_COLS)),
    rows: Math.max(1, Math.min(MAX_ROWS, rows || DEFAULT_ROWS)),
  };
}

/**
 * Reads the initial size from a PTY socket's URL query (`?cols=&rows=`), which the shell
 * is spawned with or the running PTY is resized to.
 *
 * @param params - The upgrade request's query parameters.
 * @returns The clamped size.
 */
export function sizeFromQuery(params: URLSearchParams): TermSize {
  return clampSize(
    Number.parseInt(params.get('cols') ?? String(DEFAULT_COLS), 10),
    Number.parseInt(params.get('rows') ?? String(DEFAULT_ROWS), 10),
  );
}

/**
 * Classifies one text frame from a PTY client. Only a frame starting with `{` is tried
 * as JSON, so ordinary keystrokes skip the parse; anything that is not a known control
 * message, including invalid JSON, is raw input for the shell.
 *
 * @param message - The frame, decoded as UTF-8.
 * @returns The message to apply.
 */
export function parseClientMessage(message: string): ClientMessage {
  if (message.startsWith('{')) {
    try {
      const msg = JSON.parse(message) as {
        type: string;
        cols: number;
        rows: number;
        chars: number;
      };
      if (msg.type === 'ack') return { type: 'ack', chars: Number(msg.chars) };
      if (msg.type === 'resize') {
        return { type: 'resize', ...clampSize(Math.trunc(msg.cols), Math.trunc(msg.rows)) };
      }
    } catch {
      // Not JSON: the user typed or pasted something starting with '{'.
    }
  }
  return { type: 'input', data: message };
}
