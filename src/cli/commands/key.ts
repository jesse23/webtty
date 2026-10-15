// `webtty key`: put the terminal in raw mode and print each key combo's bytes, readable and as a
// `chars` value, until `q`. A command over an injected KeyTty (ADR 063).
import type { CliDeps } from '../cli-deps';
import { bytesToChars, bytesToDisplay } from './key-format';

/** Process events after which the terminal must leave raw mode. */
export type ProcessEndEvent = 'exit' | 'SIGINT' | 'SIGTERM';

/** The terminal and process hooks `webtty key` uses. */
export interface KeyTty {
  /** Whether stdin is an interactive terminal, read when the command runs. */
  readonly isTTY: boolean;
  setRawMode(on: boolean): void;
  resume(): void;
  onData(listener: (chunk: Uint8Array) => void): void;
  /** `process.once`. */
  once(event: ProcessEndEvent, listener: () => void): void;
  /** `process.removeListener`. */
  off(event: ProcessEndEvent, listener: () => void): void;
}

/** Bytes that arrive within this many ms of each other print as one key combo. */
const COMBO_GAP_MS = 50;
const END_EVENTS: readonly ProcessEndEvent[] = ['exit', 'SIGINT', 'SIGTERM'];
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const RULE = `  ${'─'.repeat(17)}`;

/** The live `process.stdin` and `process`. */
export function processKeyTty(): KeyTty {
  return {
    get isTTY() {
      return Boolean(process.stdin.isTTY);
    },
    setRawMode: (on) => {
      process.stdin.setRawMode(on);
    },
    resume: () => {
      process.stdin.resume();
    },
    onData: (listener) => {
      process.stdin.on('data', listener);
    },
    once: (event, listener) => {
      process.once(event, listener);
    },
    off: (event, listener) => {
      process.removeListener(event, listener);
    },
  };
}

/** Prints each key combo until `q`; exits 1 when stdin is not a terminal. */
export function key({ tty, out, err, exit }: Pick<CliDeps, 'tty' | 'out' | 'err' | 'exit'>): void {
  if (!tty.isTTY) {
    err('webtty key: requires an interactive terminal');
    exit(1);
    return;
  }

  const restoreTerminal = () => {
    try {
      tty.setRawMode(false);
    } catch {}
  };
  for (const event of END_EVENTS) tty.once(event, restoreTerminal);

  tty.setRawMode(true);
  tty.resume();
  out('Press any key combo to see its chars value. q to quit.\n');
  out(`  ${DIM}received${RESET} →  ${BOLD}chars${RESET}`);
  out(RULE);

  let buf = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (buf.length === 0) return;
    const display = bytesToDisplay(buf).padEnd(8);
    out(`  ${DIM}${display}${RESET} →  ${BOLD}${bytesToChars(buf)}${RESET}`);
    buf = Buffer.alloc(0);
  };

  tty.onData((chunk) => {
    if (chunk.length === 1 && chunk[0] === 0x71) {
      tty.setRawMode(false);
      for (const event of END_EVENTS) tty.off(event, restoreTerminal);
      out(`${RULE}\n`);
      exit(0);
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, COMBO_GAP_MS);
  });
}
