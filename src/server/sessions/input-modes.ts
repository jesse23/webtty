// The terminal modes that change what the client sends, as the session's output last set them,
// so a client that joins later can be put in them before the scrollback replay (ADR 070).
// The replay is only the last `config.scrollback` characters: a full-screen app sets these
// once at start, its redraws push that out of the ring, and a new tab would then send a paste
// without bracketed-paste markers (each newline an Enter) and mouse or focus events not at all.

/**
 * DEC private modes that change the client's input encoding, in the order they are restored.
 * Display modes (cursor visibility, the alternate screen) are left to the replay itself.
 */
export const INPUT_MODES: readonly number[] = [
  1, // DECCKM: application cursor keys
  9, // X10 mouse reporting
  1000, // mouse button reporting
  1002, // mouse button-event (drag) tracking
  1003, // mouse any-event tracking
  1004, // focus in/out reporting
  1005, // UTF-8 mouse encoding
  1006, // SGR mouse encoding
  1007, // alternate scroll (wheel as arrow keys on the alternate screen)
  1015, // urxvt mouse encoding
  1016, // SGR-pixels mouse encoding
  2004, // bracketed paste
  2031, // color scheme change reports
  2048, // in-band resize reports
];

const TRACKED = new Set(INPUT_MODES);

/** A sequence this tracker acts on: DECSET/DECRST, RIS, or DECSTR. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) starts every matched sequence
const SEQUENCE = /\x1b\[\?([0-9;]*)([hl])|\x1bc|\x1b\[!p/g;

/** The unfinished start of a sequence above, held until the next chunk completes it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) starts every matched sequence
const PARTIAL = /^\x1b(?:\[(?:\?[0-9;]*|!)?)?$/;

/** Longest partial sequence carried to the next chunk; anything longer is not one of ours. */
const MAX_PARTIAL = 64;

/** Follows the input modes through a stream of output chunks; one per session. */
export class InputModes {
  private readonly set = new Set<number>();
  private partial = '';

  /** Reads one chunk of output, in order. */
  observe(data: string): void {
    if (!this.partial && !data.includes('\x1b')) return;
    const text = this.partial + data;
    this.partial = '';
    for (const match of text.matchAll(SEQUENCE)) {
      const [whole, params, final] = match;
      if (whole === '\x1bc') this.set.clear();
      else if (whole === '\x1b[!p') this.set.delete(1);
      else this.apply(params ?? '', final === 'h');
    }
    const last = text.lastIndexOf('\x1b');
    if (last !== -1 && text.length - last <= MAX_PARTIAL && PARTIAL.test(text.slice(last))) {
      this.partial = text.slice(last);
    }
  }

  /** The DECSET that puts a fresh terminal in the modes now set, or `''` if none is. */
  restore(): string {
    const on = INPUT_MODES.filter((mode) => this.set.has(mode));
    return on.length ? `\x1b[?${on.join(';')}h` : '';
  }

  private apply(params: string, enable: boolean): void {
    for (const param of params.split(';')) {
      const mode = Number(param);
      if (!TRACKED.has(mode)) continue;
      if (enable) this.set.add(mode);
      else this.set.delete(mode);
    }
  }
}
