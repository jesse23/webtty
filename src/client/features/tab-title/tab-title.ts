// The tab title and its bell mark (object, ADR 053): the program's title or the session
// id, as `<title> | webtty`, with a 🔔 after a bell until the terminal is attended.

const BELL_MARK = '🔔 ';

/**
 * The tab title (ADR 053): the program's OSC 0/2 title, or the session id while it has
 * set none, as `<title> | webtty`, with a 🔔 in front after a bell until the terminal
 * gains focus or a key is pressed, as Ghostty's `bell-features = title` does.
 *
 * A title in the replay is applied (it is the title the program last set), but a bell
 * in it is not a new bell: bells are ignored while `replay` is active.
 */
export class TabTitle {
  private appTitle = '';
  private ringing = false;

  constructor(
    private readonly sessionId: string,
    private readonly bellTitle: boolean,
    private readonly replay: { readonly active: boolean },
    private readonly set: (title: string) => void,
  ) {
    this.update();
  }

  /** The program's title, or the session id while it has set none. */
  get name(): string {
    return this.appTitle || this.sessionId;
  }

  /** The program set its title (`''` for none). */
  title(title: string): void {
    this.appTitle = title;
    this.update();
  }

  /** The program rang the bell, or a notification could not be shown (ADR 056). */
  bell(): void {
    if (!this.bellTitle || this.replay.active || this.ringing) return;
    this.ringing = true;
    this.update();
  }

  /** The terminal gained focus or got a key: the bell has been seen. */
  attended(): void {
    if (!this.ringing) return;
    this.ringing = false;
    this.update();
  }

  private update(): void {
    this.set(`${this.ringing ? BELL_MARK : ''}${this.name} | webtty`);
  }
}
