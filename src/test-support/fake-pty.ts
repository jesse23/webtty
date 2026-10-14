// A scriptable stand-in for a PTY: records writes, resizes and kills in a shared log and
// lets a test emit output and exit. A test-support object for the session and socket tests
// (ADR 064).
import type { PtyProcess } from '../pty';

/** A PtyProcess that runs no shell, so session lifecycle tests are fast and deterministic. */
export class FakePty implements PtyProcess {
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((e: { exitCode: number }) => void) | null = null;

  /**
   * @param log - Shared event log; entries read `pty.write <json>`, `pty.resize CxR`, `pty.kill`.
   * @param pid - The process ID to report.
   */
  constructor(
    readonly log: string[] = [],
    readonly pid = 4242,
  ) {}

  onData(cb: (data: string) => void): void {
    this.dataListener = cb;
  }

  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitListener = cb;
  }

  write(data: string): void {
    this.log.push(`pty.write ${JSON.stringify(data)}`);
  }

  resize(cols: number, rows: number): void {
    this.log.push(`pty.resize ${cols}x${rows}`);
  }

  kill(): void {
    this.log.push('pty.kill');
  }

  /** Delivers `data` as if the shell had written it. */
  emitData(data: string): void {
    this.dataListener?.(data);
  }

  /** Reports that the shell exited. */
  emitExit(exitCode = 0): void {
    this.exitListener?.({ exitCode });
  }
}
