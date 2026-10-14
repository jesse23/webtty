// The fixed per-message call order for PTY output (util, ADR 048, ADR 053, ADR 060).
// It runs for every message, so it is a direct call sequence and allocates nothing.

/** The parts the pipeline calls, as structural slices so connection/ imports no feature. */
export interface OutputPipelineParts {
  /** ReplayWindow: whether the output being parsed is the replay (ADR 053). */
  replay: { output(chars: number, now: number): void; parsed(now: number): void };
  /** KittyGraphics: takes the APC sequences out and writes the rest to the terminal (ADR 032). */
  graphics: { feed(data: string): void };
  /** SmoothScroll: keeps the scrollback glide in step with new output (ADR 040). */
  smoothScroll: { onOutput(): void };
  /** `performance.now()`. */
  now(): number;
}

/** The slice of OutputAck the pipeline uses: one per socket, passed in by PtyConnection. */
export interface OutputAckSink {
  parsed(chars: number): void;
}

/** A handler for one output message on the socket whose ack is `ack`. */
export type OutputHandler = (data: string, ack: OutputAckSink) => void;

/**
 * Builds the handler every output message goes through. `term.write()` parses
 * synchronously, so the output has been parsed once `feed()` returns: acknowledging it
 * then lets a slow tab slow the server down (ADR 048).
 */
export function createOutputHandler(parts: OutputPipelineParts): OutputHandler {
  const { replay, graphics, smoothScroll, now } = parts;
  return (data, ack) => {
    replay.output(data.length, now());
    graphics.feed(data);
    replay.parsed(now());
    ack.parsed(data.length);
    smoothScroll.onOutput();
  };
}
