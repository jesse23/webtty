// The banner a new session prints before the shell's first prompt (ADR 062). A pure
// function of the package runner, so its exact bytes can be pinned by a test.

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const ITALIC = '\x1b[3m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[1;36m';

/** Inner width of the box in columns; every line pads its visible text to this. */
const W = 48;

/** Wraps one line of content in the box's side borders. */
function pipe(content: string): string {
  return `${CYAN}║${RESET}${content}${CYAN}║${RESET}`;
}

/**
 * Builds the boxed welcome banner written to a session's first client and kept as the
 * start of its scrollback, so a later client sees it too.
 *
 * @param runner - The package runner the help hint suggests (`bunx` or `npx`).
 * @returns The banner, with `\r\n` line endings and a trailing blank line.
 */
export function sessionBanner(runner: string): string {
  const blank = pipe(' '.repeat(W));

  // Each *Vis string is the line's visible text, used only to measure the padding.
  const titleVis = ' [ webtty ]   Terminal UI in the browser';
  const titleStr = ` ${DIM}[${RESET} ${BOLD}${YELLOW}webtty${RESET} ${DIM}]   Terminal UI in the browser${RESET}`;
  const titleLine = pipe(titleStr + ' '.repeat(W - titleVis.length));

  const cmd = `${runner} webtty help`;
  const helpVis = ` Run \`${cmd}\` for more information.`;
  const helpStr = ` ${DIM}Run \`${RESET}${ITALIC}${cmd}${RESET}${DIM}\` for more information.${RESET}`;
  const helpLine = pipe(helpStr + ' '.repeat(W - helpVis.length));

  return [
    `${CYAN}╔${'═'.repeat(W)}╗${RESET}`,
    '\r\n',
    blank,
    '\r\n',
    titleLine,
    '\r\n',
    blank,
    '\r\n',
    helpLine,
    '\r\n',
    blank,
    '\r\n',
    `${CYAN}╚${'═'.repeat(W)}╝${RESET}`,
    '\r\n',
    '\r\n',
  ].join('');
}
