import { homedir } from 'node:os';
import type { PtyProcess } from './types';

/**
 * Spawns a PTY-backed shell using Bun's native `Bun.spawn` terminal API.
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
  let onDataCb: ((data: string) => void) | undefined;
  let onExitCb: ((e: { exitCode: number }) => void) | undefined;
  let dataCount = 0;

  console.log(`[pty:bun] spawn shell=${shell} cols=${cols} rows=${rows} cwd=${homedir()}`);

  const proc = Bun.spawn([shell], {
    terminal: {
      cols,
      rows,
      data(_term: unknown, data: Uint8Array) {
        const str = Buffer.from(data).toString('utf8');
        if (dataCount++ < 5) console.log(`[pty:bun] data #${dataCount} ${str.length}B`);
        onDataCb?.(str);
      },
    },
    cwd: homedir(),
    env: { ...process.env, TERM: term, COLORTERM: colorTerm },
  });

  console.log(`[pty:bun] spawned pid=${proc.pid} terminal=${proc.terminal != null ? 'ok' : 'NULL'}`);

  proc.exited.then((exitCode) => {
    console.log(`[pty:bun] pid=${proc.pid} exited exitCode=${exitCode}`);
    onExitCb?.({ exitCode: exitCode ?? 0 });
  });

  return {
    pid: proc.pid,
    onData(cb) {
      onDataCb = cb;
    },
    onExit(cb) {
      onExitCb = cb;
    },
    write(data) {
      console.log(`[pty:bun] write ${JSON.stringify(data.slice(0, 40))}`);
      proc.terminal?.write(data);
    },
    resize(cols, rows) {
      console.log(`[pty:bun] resize cols=${cols} rows=${rows}`);
      proc.terminal?.resize(cols, rows);
    },
    kill() {
      console.log(`[pty:bun] kill pid=${proc.pid}`);
      proc.kill();
    },
  };
}
