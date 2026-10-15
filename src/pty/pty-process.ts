// The PTY layer's types: the handle to a running shell and the options that start one.
// Implemented by the Bun and node-pty backends and consumed by the server's sessions (ADR 062).

/** Minimal abstraction over a running PTY process. Implemented by both the Bun and node-pty backends. */
export interface PtyProcess {
  /** OS process ID of the shell spawned inside the PTY. */
  pid: number;
  /** Register a callback that receives raw UTF-8 output from the PTY. */
  onData(cb: (data: string) => void): void;
  /** Register a callback invoked when the child process exits. */
  onExit(cb: (e: { exitCode: number }) => void): void;
  /** Write raw input to the PTY (keyboard data, escape sequences, etc.). */
  write(data: string): void;
  /** Notify the PTY of a terminal resize. */
  resize(cols: number, rows: number): void;
  /**
   * Stop reading output, so the app blocks on its writes once the PTY's buffer is
   * full. Only node-pty has it: `Bun.Terminal` cannot pause (ADR 048).
   */
  pause?(): void;
  /** Read output again after {@link PtyProcess.pause}. */
  resume?(): void;
  /** Terminate the child process. */
  kill(): void;
}

/** Everything needed to start a shell in a PTY; one object instead of seven positional arguments. */
export interface PtySpawnOptions {
  /** Shell executable path (e.g. `/bin/bash`). */
  shell: string;
  /** Terminal width in columns. */
  cols: number;
  /** Terminal height in rows. */
  rows: number;
  /** `$TERM` for the shell (e.g. `xterm-256color`). */
  term: string;
  /** `$COLORTERM` for the shell (e.g. `truecolor`). */
  colorTerm: string;
  /** Working directory for the shell. */
  cwd: string;
  /** Extra environment from the config, layered over the server's own environment. */
  env: Record<string, string>;
}

/** Starts a shell in a PTY; each backend is one of these, and so is a test's fake. */
export type SpawnPty = (options: PtySpawnOptions) => PtyProcess;
