export type { PtyProcess } from './types';

const isBun = !!process.versions.bun;
console.log(`pty: ${isBun ? 'Bun.Terminal' : 'node-pty'}`);

const { spawn: _spawn } = await (isBun ? import('./bun') : import('./node'));

export const spawn = _spawn;

export function spawnForSession(cols: number, rows: number) {
  const shell =
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/bash');
  return _spawn(shell, cols, rows);
}
