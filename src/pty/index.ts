import { bunTerminalAvailable } from '../runtime';

export type { PtyProcess } from './pty-process';

// Bun.Terminal does not implement PTY on Windows (Bun.spawn({ terminal })
// is a no-op there), so fall back to node-pty on that platform.
// On all other platforms, prefer Bun.Terminal when running under Bun.
const useBunTerminal = bunTerminalAvailable();
console.log(`pty: ${useBunTerminal ? 'Bun.Terminal' : 'node-pty'}`);

const { spawn: _spawn } = await (useBunTerminal
  ? import('./bun-backend')
  : import('./node-backend'));

export const spawn = _spawn;

/**
 * Convenience wrapper: spawns a PTY using session-oriented parameters from config.
 *
 * @param cols - Terminal width in columns.
 * @param rows - Terminal height in rows.
 * @param shell - Shell executable path (e.g., `/bin/bash`).
 * @param term - `$TERM` environment variable (e.g., `xterm-256color`).
 * @param colorTerm - `$COLORTERM` environment variable (e.g., `truecolor`).
 * @param cwd - Working directory for the shell.
 * @returns A {@link PtyProcess} handle for reading/writing and managing the PTY.
 */
export function spawnForSession(
  cols: number,
  rows: number,
  shell: string,
  term: string,
  colorTerm: string,
  cwd: string,
  env: Record<string, string>,
) {
  return _spawn(shell, cols, rows, term, colorTerm, cwd, env);
}
