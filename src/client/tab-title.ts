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

const BELL_MARK = '🔔 ';

/**
 * The tab title (ADR 053): the program's OSC 0/2 title, or the session id while it has
 * set none, as `<title> | webtty`, with a 🔔 in front after a bell until the terminal
 * gains focus or a key is pressed, as Ghostty's `bell-features = title` does.
 *
 * The server replays the session's recent output on every connect. A title in it is
 * applied (it is the title the program last set), but a bell in it is not a new bell:
 * bells are ignored from each connect through the first message shorter than
 * {@link REPLAY_PIECE}, the replay's last piece, or until the output pauses for
 * {@link REPLAY_QUIET_MS}.
 */
export class TabTitle {
  private appTitle = '';
  private ringing = false;
  private replaying = false;
  private lastParsed: number | null = null;
  private lastWasTail = false;

  constructor(
    private readonly sessionId: string,
    private readonly bellTitle: boolean,
    private readonly set: (title: string) => void,
  ) {
    this.update();
  }

  /** The program set its title (`''` for none). */
  title(title: string): void {
    this.appTitle = title;
    this.update();
  }

  /** The program rang the bell. */
  bell(): void {
    if (!this.bellTitle || this.replaying || this.ringing) return;
    this.ringing = true;
    this.update();
  }

  /** The terminal gained focus or got a key: the bell has been seen. */
  attended(): void {
    if (!this.ringing) return;
    this.ringing = false;
    this.update();
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

  private update(): void {
    const name = this.appTitle || this.sessionId;
    this.set(`${this.ringing ? BELL_MARK : ''}${name} | webtty`);
  }
}
