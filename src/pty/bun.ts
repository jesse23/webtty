import { homedir } from 'node:os';
import type { PtyProcess } from './types';

/** Spawns a PTY-backed shell using Bun's native `Bun.spawn` terminal API. */
export function spawn(
  shell: string,
  cols: number,
  rows: number,
  term: string,
  colorTerm: string,
): PtyProcess {
  let onDataCb: ((data: string) => void) | undefined;
  let onExitCb: ((e: { exitCode: number }) => void) | undefined;

  const proc = Bun.spawn([shell], {
    terminal: {
      cols,
      rows,
      data(_term: unknown, data: Uint8Array) {
        onDataCb?.(Buffer.from(data).toString('utf8'));
      },
    },
    cwd: homedir(),
    env: { ...process.env, TERM: term, COLORTERM: colorTerm },
  });

  proc.exited.then((exitCode) => {
    onExitCb?.({ exitCode: exitCode ?? 0 });
  });

  return {
    onData(cb) {
      onDataCb = cb;
    },
    onExit(cb) {
      onExitCb = cb;
    },
    write(data) {
      proc.terminal?.write(data);
    },
    resize(cols, rows) {
      proc.terminal?.resize(cols, rows);
    },
    kill() {
      proc.kill();
    },
  };
}
