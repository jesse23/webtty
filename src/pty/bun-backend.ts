// The Bun.Terminal PTY backend: a SpawnPty built on Bun's native `Bun.spawn({ terminal })`.
// Used under Bun on every platform but Windows (ADR 062); it cannot pause (ADR 048).
import type { PtyProcess, PtySpawnOptions } from './pty-process';

/**
 * Spawns a PTY-backed shell using Bun's native `Bun.spawn` terminal API.
 *
 * @returns A {@link PtyProcess} handle for reading/writing and managing the PTY.
 */
export function spawnBunPty(options: PtySpawnOptions): PtyProcess {
  const { shell, cols, rows, term, colorTerm, cwd, env } = options;
  let onDataCb: ((data: string) => void) | undefined;
  let onExitCb: ((e: { exitCode: number }) => void) | undefined;
  // One streaming decoder per PTY: a read can end mid-character, and decoding each
  // chunk on its own turns both halves of a split multi-byte character (e.g. `─`)
  // into U+FFFD. The decoder holds the partial bytes until the rest arrives.
  const decoder = new TextDecoder();

  const proc = Bun.spawn([shell], {
    terminal: {
      cols,
      rows,
      data(_term: unknown, data: Uint8Array) {
        const text = decoder.decode(data, { stream: true });
        if (text) onDataCb?.(text);
      },
    },
    cwd,
    env: { ...process.env, ...env, TERM: term, COLORTERM: colorTerm },
  });

  proc.exited.then((exitCode) => {
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
      proc.terminal?.write(data);
    },
    resize(cols, rows) {
      proc.terminal?.resize(cols, rows);
    },
    kill() {
      // SIGHUP, as a terminal sends when it closes: an interactive shell ignores the
      // default SIGTERM, which left it and the apps in it running after a session was
      // deleted. node-pty sends SIGHUP too. The shell passes the hangup to its jobs.
      proc.kill('SIGHUP');
    },
  };
}
