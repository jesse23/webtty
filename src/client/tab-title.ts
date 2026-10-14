/**
 * Output quiet for this long after a connect ends the replay; bells before it are the
 * replay's (ADR 053). The server sends the whole replay as one burst at connect.
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
 * bells are ignored from each connect until the output first pauses for
 * {@link REPLAY_QUIET_MS}.
 */
export class TabTitle {
  private appTitle = '';
  private ringing = false;
  private replaying = false;
  private lastOutput: number | null = null;

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
    this.lastOutput = null;
  }

  /** Output arrived at `now` (ms) and is about to be parsed. */
  output(now: number): void {
    if (this.replaying && this.lastOutput !== null && now - this.lastOutput >= REPLAY_QUIET_MS) {
      this.replaying = false;
    }
    this.lastOutput = now;
  }

  private update(): void {
    const name = this.appTitle || this.sessionId;
    this.set(`${this.ringing ? BELL_MARK : ''}${name} | webtty`);
  }
}
