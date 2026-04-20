export type { PtyProcess } from './types';

// Bun.Terminal does not support the `terminal` option on Windows; fall back to node-pty.
const isBun = !!process.versions.bun && process.platform !== 'win32';
console.log(`pty: ${isBun ? 'Bun.Terminal' : 'node-pty'}`);

const { spawn: _spawn } = await (isBun ? import('./bun') : import('./node'));

export const spawn = _spawn;

/**
 * Convenience wrapper: spawns a PTY using session-oriented parameters from config.
 *
 * @param cols - Terminal width in columns.
 * @param rows - Terminal height in rows.
 * @param shell - Shell executable path (e.g., `/bin/bash`).
 * @param term - `$TERM` environment variable (e.g., `xterm-256color`).
 * @param colorTerm - `$COLORTERM` environment variable (e.g., `truecolor`).
 * @returns A {@link PtyProcess} handle for reading/writing and managing the PTY.
 */
export function spawnForSession(
  cols: number,
  rows: number,
  shell: string,
  term: string,
  colorTerm: string,
) {
  return _spawn(shell, cols, rows, term, colorTerm);
}
