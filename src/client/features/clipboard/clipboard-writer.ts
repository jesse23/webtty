/** The part of `navigator.clipboard` a program's clipboard write uses. */
export interface TextClipboard {
  writeText(text: string): Promise<void>;
}

/**
 * Writes the browser clipboard for a program's OSC 52 (ADR 052). The terminal decodes
 * the sequence; this decides whether the write happens and reports why not, once per
 * reason, on the console. There is no error UI: the program cannot be told either way.
 *
 * Writes are held back after each (re)connect until the user presses a key, clicks or
 * pastes in the tab. The server replays the session's recent output on connect, and an
 * OSC 52 in it would otherwise overwrite the clipboard on every reload with something
 * copied long ago.
 *
 * The browser may still refuse: Chrome writes only while the document has focus,
 * Firefox only shortly after user input, Safari only inside the input event itself.
 */
export class ClipboardWriter {
  private armed = false;
  private readonly logged = new Set<string>();

  constructor(
    private readonly clipboard: TextClipboard | undefined,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** A connection opened: the output that follows starts with the replay. */
  connected(): void {
    this.armed = false;
  }

  /** The user pressed a key, clicked or pasted in this tab. */
  userInput(): void {
    this.armed = true;
  }

  /** Writes `text` (`''` clears) to the clipboard if allowed; settles when done. */
  async write(text: string): Promise<void> {
    if (!this.armed) {
      this.once('replay', 'webtty: ignored an OSC 52 clipboard write before any input in this tab');
      return;
    }
    if (!this.clipboard) {
      this.once(
        'api',
        'webtty: OSC 52 clipboard write ignored: no clipboard API (needs https or localhost)',
      );
      return;
    }
    try {
      await this.clipboard.writeText(text);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.once('refused', `webtty: the browser refused an OSC 52 clipboard write: ${reason}`);
    }
  }

  private once(key: string, message: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(message);
  }
}
