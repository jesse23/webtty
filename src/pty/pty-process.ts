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
