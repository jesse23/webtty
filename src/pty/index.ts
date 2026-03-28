export type { PtyProcess } from './types';

const isBun = !!process.versions.bun;
console.log(`pty: ${isBun ? 'Bun.Terminal' : 'node-pty'}`);

const { spawn: _spawn } = await (isBun ? import('./bun') : import('./node'));

export const spawn = _spawn;

/** Convenience wrapper: spawns a PTY using session-oriented parameters from config. */
export function spawnForSession(
  cols: number,
  rows: number,
  shell: string,
  term: string,
  colorTerm: string,
) {
  return _spawn(shell, cols, rows, term, colorTerm);
}
