// The "[ webtty ]" status line the client writes into the terminal when the connection
// changes (util, pure, ADR 060): a dim tag and dim italic text on a line of their own.

const DIM = '\x1b[2m';
const YELLOW = '\x1b[1;33m';
const ITALIC = '\x1b[3m';
const RESET = '\x1b[0m';
const TAG = `${DIM}[${RESET} ${YELLOW}webtty${RESET} ${DIM}]${RESET}`;

/** The terminal bytes that show `text` as a webtty status line, for `term.write()`. */
export function statusLine(text: string): string {
  return `\r\n${TAG} ${DIM}${ITALIC}${text}${RESET}\r\n`;
}
