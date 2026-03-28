import { homedir } from 'node:os';
import nodePty from '@lydell/node-pty';
import type { PtyProcess } from './types';

/** Spawns a PTY-backed shell using the `@lydell/node-pty` native addon. */
export function spawn(
  shell: string,
  cols: number,
  rows: number,
  term: string,
  colorTerm: string,
): PtyProcess {
  const ptyProc = nodePty.spawn(shell, [], {
    name: term,
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, TERM: term, COLORTERM: colorTerm },
  });

  return {
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
