// Newline-delimited JSON framing shared by the server's /publish route and the CLI's `run`
// (ADR 062, ADR 063). An object: a LineSplitter turns arbitrary stream chunks into whole lines.

/** How a {@link LineSplitter} treats line endings and an unterminated line. */
export interface LineSplitterOptions {
  /**
   * Drop the pending partial line once it grows past this many characters, so a peer that
   * never sends a newline cannot grow the buffer without bound. No limit when omitted.
   */
  maxLength?: number;
  /** Strip one trailing `\r` from each line (CRLF input). Defaults to true. */
  stripCarriageReturn?: boolean;
}

/**
 * Splits a chunked text stream into lines on `\n`, holding back the partial last line until
 * the next chunk or {@link flush}. Empty lines are skipped. One splitter per stream.
 */
export class LineSplitter {
  private pending = '';
  private readonly maxLength: number;
  private readonly stripCarriageReturn: boolean;

  constructor(options: LineSplitterOptions = {}) {
    this.maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
    this.stripCarriageReturn = options.stripCarriageReturn ?? true;
  }

  /** Appends `chunk` and returns the non-empty lines it completed, in order. */
  push(chunk: string): string[] {
    const parts = (this.pending + chunk).split('\n');
    this.pending = parts.pop() ?? '';
    if (this.pending.length > this.maxLength) this.pending = '';
    const lines: string[] = [];
    for (const part of parts) {
      const line = this.clean(part);
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Returns the unterminated last line at end of stream (or null if none), and clears it. */
  flush(): string | null {
    const line = this.clean(this.pending);
    this.pending = '';
    return line || null;
  }

  private clean(line: string): string {
    return this.stripCarriageReturn ? line.replace(/\r$/, '') : line;
  }
}
