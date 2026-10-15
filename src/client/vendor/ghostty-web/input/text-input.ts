// Derived from coder/ghostty-web lib/input-handler.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Text input from IMEs and mobile keyboards (object + util): the beforeinput text, the
// EchoGuard that drops text a browser reports twice (a keydown and its beforeinput, a
// composition and its beforeinput) within 100 ms, and the composition text-node cleanup.

/** How long after one path sends text the same text on another path is an echo. */
export const ECHO_WINDOW_MS = 100;

/** The clock the guard reads, in ms: `performance.now()` where it exists, else `Date.now()`. */
export function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * What a `beforeinput` sends, or null for one the terminal leaves alone (an empty
 * insert, and every input type not listed). Paste is not here: webtty's capture
 * listener takes every paste first (ADR 037), and a cancelled paste fires no
 * insertFromPaste. (webtty)
 */
export function beforeInputText(inputType: string, data: string): string | null {
  switch (inputType) {
    case 'insertText':
    case 'insertReplacementText':
      return data.length > 0 ? data.replace(/\n/g, '\r') : null;
    case 'insertLineBreak':
    case 'insertParagraph':
      return '\r';
    case 'deleteContentBackward':
      return '\x7F';
    case 'deleteContentForward':
      return '\x1B[3~';
    default:
      return null;
  }
}

/** The last text one path sent and when. */
interface Sent {
  data: string | null;
  time: number;
}

/**
 * Remembers the text each input path last sent, so the other path's report of the same
 * text within ECHO_WINDOW_MS is dropped. The three checks clear differently, as upstream
 * did: a keydown is matched against the next beforeinput only, a composition or a
 * beforeinput until it is matched.
 */
export class EchoGuard {
  private keyDown: Sent = { data: null, time: 0 };
  private composition: Sent = { data: null, time: 0 };
  private beforeInput: Sent = { data: null, time: 0 };

  constructor(private readonly now: () => number = defaultNow) {}

  /** A keydown sent `data`. */
  recordKeyDown(data: string): void {
    this.keyDown = { data, time: this.now() };
  }

  /** A composition end sent `data`. */
  recordComposition(data: string): void {
    this.composition = { data, time: this.now() };
  }

  /** A beforeinput sent `data`. */
  recordBeforeInput(data: string): void {
    this.beforeInput = { data, time: this.now() };
  }

  /** Whether a beforeinput's `output` repeats the last keydown; the keydown is forgotten either way. */
  isKeyDownEcho(output: string): boolean {
    const echo = this.matches(this.keyDown, output);
    this.keyDown.data = null;
    return echo;
  }

  /** Whether a beforeinput's text repeats the last composition, which is forgotten if so. */
  isCompositionEcho(data: string): boolean {
    return this.consume(this.composition, data);
  }

  /** Whether a composition's text repeats the last beforeinput, which is forgotten if so. */
  isBeforeInputEcho(data: string): boolean {
    return this.consume(this.beforeInput, data);
  }

  private consume(sent: Sent, data: string): boolean {
    const echo = this.matches(sent, data);
    if (echo) sent.data = null;
    return echo;
  }

  private matches(sent: Sent, data: string): boolean {
    if (!sent.data) return false;
    return this.now() - sent.time < ECHO_WINDOW_MS && sent.data === data;
  }
}

/** `Node.TEXT_NODE`, spelled out so the module loads where there is no DOM. */
const TEXT_NODE = 3;

/**
 * Removes the text nodes a browser may insert into a contenteditable container when a
 * composition ends, so the text does not show twice.
 */
export function removeCompositionText(container: Node): void {
  if (!container.childNodes) return;
  for (let i = container.childNodes.length - 1; i >= 0; i--) {
    const node = container.childNodes[i];
    if (node.nodeType === TEXT_NODE) container.removeChild(node);
  }
}
