// Sends pastes to the PTY (service, ADR 014, ADR 037, ADR 049, ADR 060): text through the
// terminal, which encodes it as Ghostty does, a non-text paste as Ctrl+V, and a clipboard
// read for the keys and the right click that paste without a browser `paste` event.

import { nonTextPaste } from './non-text-paste';

/** The terminal as a paste reaches it. */
export interface PasteTerminal {
  /** Encodes and sends text: bracketed under mode 2004, control bytes stripped (ADR 049). */
  paste(text: string): void;
  scrollToBottom(): void;
}

/** The PTY socket as the paste service writes to it. */
export interface PasteSink {
  isOpen(): boolean;
  send(data: string): void;
}

/** The navigator as the paste service reads it; `clipboard` is read at each paste. */
export interface ClipboardSource {
  readonly clipboard?: Pick<Clipboard, 'readText'>;
}

/** Ctrl+V, the key a non-text paste and a failed clipboard read send. */
const CTRL_V = '\x16';

/** Routes each paste to the terminal or the socket; nothing is sent while the socket is down. */
export class PasteService {
  constructor(
    private readonly term: PasteTerminal,
    private readonly connection: PasteSink,
    private readonly navigator: ClipboardSource,
  ) {}

  /**
   * Pastes `text`. Empty text is a non-text paste (an image): the receiving TUI may read
   * the native clipboard on Ctrl+V. Ctrl+V is never a text fallback, since remote TUIs
   * can read it as an image-paste shortcut (ADR 037).
   */
  paste(text: string): void {
    if (!this.connection.isOpen()) return;
    const ctrlV = nonTextPaste(text);
    if (ctrlV) {
      this.term.scrollToBottom();
      this.connection.send(ctrlV);
    } else this.term.paste(text);
  }

  /**
   * Reads the clipboard and pastes it, as Cmd+V does; a failed read sends Ctrl+V.
   * Returns false when the browser cannot read the clipboard.
   */
  pasteFromClipboard(): boolean {
    const clipboard = this.navigator.clipboard;
    if (!clipboard?.readText) return false;
    clipboard.readText().then(
      (text) => this.paste(text),
      () => this.sendCtrlV(),
    );
    return true;
  }

  /**
   * ghostty-web swallows Ctrl+V without sending it to the PTY (unlike xterm.js) and relies
   * on the browser `paste` event, which on macOS fires only for Cmd+V (ADR 014).
   */
  private sendCtrlV(): void {
    if (!this.connection.isOpen()) return;
    this.term.scrollToBottom();
    this.connection.send(CTRL_V);
  }
}
