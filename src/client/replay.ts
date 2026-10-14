/**
 * The size, in characters, of the pieces the server sends the replay in (its
 * `FlowLimits.chunk`, ADR 048): every piece but the last is this long, or one shorter
 * where it would split a surrogate pair. A shorter message ends the replay (ADR 053).
 */
export const REPLAY_PIECE = 64 * 1024;

/**
 * Output quiet for this long, after the previous message was parsed, also ends the
 * replay: for a replay whose last piece is full length (ADR 053).
 */
export const REPLAY_QUIET_MS = 1000;

/**
 * Whether the output being parsed is the replay (ADR 053). The server replays the
 * session's recent output on every connect; a bell or a notification in it is not a new
 * one (ADR 056). Output is replay from each connect through the first message shorter
 * than {@link REPLAY_PIECE}, the replay's last piece, or until the output pauses for
 * {@link REPLAY_QUIET_MS}.
 */
export class ReplayWindow {
  private replaying = false;
  private lastParsed: number | null = null;
  private lastWasTail = false;

  /** Whether the message being parsed is replay. */
  get active(): boolean {
    return this.replaying;
  }

  /** A connection opened: the output that follows starts with the replay. */
  connected(): void {
    this.replaying = true;
    this.lastParsed = null;
    this.lastWasTail = false;
  }

  /** A message of `chars` characters arrived at `now` (ms) and is about to be parsed. */
  output(chars: number, now: number): void {
    if (
      this.replaying &&
      this.lastParsed !== null &&
      (this.lastWasTail || now - this.lastParsed >= REPLAY_QUIET_MS)
    ) {
      this.replaying = false;
    }
    this.lastWasTail = chars < REPLAY_PIECE - 1;
  }

  /** The message passed to {@link output} was parsed at `now` (ms). */
  parsed(now: number): void {
    this.lastParsed = now;
  }
}
