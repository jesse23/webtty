import { homedir } from 'node:os';
import nodePty from '@lydell/node-pty';
import type { PtyProcess } from './index.ts';

export function spawn(shell: string, cols: number, rows: number): PtyProcess {
  const ptyProc = nodePty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
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
