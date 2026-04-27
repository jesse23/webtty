import { homedir } from 'node:os';
import nodePty from '@lydell/node-pty';
import type { PtyProcess } from './types';

/**
 * Spawns a PTY-backed shell using the `@lydell/node-pty` native addon.
 *
 * @param shell - Shell executable path (e.g., `/bin/bash`).
 * @param cols - Terminal width in columns.
 * @param rows - Terminal height in rows.
 * @param term - `$TERM` environment variable (e.g., `xterm-256color`).
 * @param colorTerm - `$COLORTERM` environment variable (e.g., `truecolor`).
 * @returns A {@link PtyProcess} handle for reading/writing and managing the PTY.
 */
export function spawn(
  shell: string,
  cols: number,
  rows: number,
  term: string,
  colorTerm: string,
): PtyProcess {
  // On Windows, cmd.exe may have an AutoRun registry key that launches shell
  // enhancers (e.g. clink). These take over the ConPTY pipe and cause
  // ERR_SOCKET_CLOSED on the first write. Pass /d to disable AutoRun.
  const shellArgs = process.platform === 'win32' && /cmd\.exe$/i.test(shell) ? ['/d'] : [];

  const ptyProc = nodePty.spawn(shell, shellArgs, {
    name: term,
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, TERM: term, COLORTERM: colorTerm },
  });

  return {
    pid: ptyProc.pid,
    onData(cb) {
      ptyProc.onData(cb);
    },
    onExit(cb) {
      ptyProc.onExit(cb);
    },
    write(data) {
      ptyProc.write(data);
    },
    resize(cols, rows) {
      ptyProc.resize(cols, rows);
    },
    kill() {
      ptyProc.kill();
    },
  };
}
