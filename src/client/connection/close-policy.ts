// What the tab does when its PTY socket closes, by close code (util, pure, ADR 048,
// ADR 060). PtyConnection carries the action out; keeping the decision here lets each
// code and its exact message be tested without a socket.

import { CLOSE_CODE } from './close-codes';

/** How long a closed tab waits before it reconnects, in ms. */
export const RETRY_MS = 2000;
/** How long the tab shows its final status line before it closes the window, in ms. */
export const CLOSE_WINDOW_MS = 500;

/**
 * What to do after a close: `replay` resets the terminal and reconnects at once,
 * `close-window` closes the tab after `delayMs`, `retry` reconnects after `delayMs`.
 * Each writes `message` as a status line first.
 */
export type CloseAction =
  | { readonly kind: 'replay'; readonly message: string }
  | { readonly kind: 'close-window'; readonly message: string; readonly delayMs: number }
  | { readonly kind: 'retry'; readonly message: string; readonly delayMs: number };

// The server dropped this tab for falling too far behind the output. Start again from
// the replay, as a new tab would (ADR 048).
const FELL_BEHIND: CloseAction = {
  kind: 'replay',
  message: 'Tab fell behind; replaying recent output.',
};
const SESSION_GONE: CloseAction = {
  kind: 'close-window',
  message: 'Session removed.',
  delayMs: CLOSE_WINDOW_MS,
};
const SERVER_STOPPED: CloseAction = {
  kind: 'close-window',
  message: 'Server stopped.',
  delayMs: CLOSE_WINDOW_MS,
};
const LOST: CloseAction = {
  kind: 'retry',
  message: 'Connection lost. Reconnecting in 2s...',
  delayMs: RETRY_MS,
};

/** The action for a socket closed with `code`; any code not listed is a lost connection. */
export function closeActionFor(code: number): CloseAction {
  switch (code) {
    case CLOSE_CODE.FELL_BEHIND:
      return FELL_BEHIND;
    case CLOSE_CODE.SESSION_GONE:
      return SESSION_GONE;
    case CLOSE_CODE.SERVER_STOPPED:
      return SERVER_STOPPED;
    default:
      return LOST;
  }
}
