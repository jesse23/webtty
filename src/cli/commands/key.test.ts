import { describe, expect, spyOn, test } from 'bun:test';
import { fakeCliDeps } from '../test-support/fake-cli-deps';
import { type KeyTty, key, type ProcessEndEvent, processKeyTty } from './key';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const RULE = `  ${'─'.repeat(17)}`;

/** A TTY that records raw mode, listeners and process hooks, and lets the test type bytes. */
function fakeTty(isTTY = true) {
  const rawMode: boolean[] = [];
  const hooks: Array<[string, ProcessEndEvent]> = [];
  const restorers = new Map<ProcessEndEvent, () => void>();
  let onData: ((chunk: Uint8Array) => void) | undefined;
  let resumed = false;
  const tty: KeyTty = {
    isTTY,
    setRawMode: (on) => {
      rawMode.push(on);
    },
    resume: () => {
      resumed = true;
    },
    onData: (listener) => {
      onData = listener;
    },
    once: (event, listener) => {
      hooks.push(['once', event]);
      restorers.set(event, listener);
    },
    off: (event, listener) => {
      hooks.push(['off', event]);
      if (restorers.get(event) === listener) restorers.delete(event);
    },
  };
  const type = (...bytes: number[]) => onData?.(Buffer.from(bytes));
  return { tty, rawMode, hooks, restorers, type, resumed: () => resumed };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('key', () => {
  test('exits 1 when stdin is not a terminal', () => {
    const { tty, rawMode } = fakeTty(false);
    const fake = fakeCliDeps({}, { tty });
    key(fake.deps);
    expect(fake.err).toEqual(['webtty key: requires an interactive terminal']);
    expect(fake.exits).toEqual([1]);
    expect(rawMode).toEqual([]);
  });

  test('prints the header, then each combo once its bytes stop arriving', async () => {
    const t = fakeTty();
    const fake = fakeCliDeps({}, { tty: t.tty });
    key(fake.deps);
    expect(t.rawMode).toEqual([true]);
    expect(t.resumed()).toBe(true);
    expect(fake.out).toEqual([
      'Press any key combo to see its chars value. q to quit.\n',
      `  ${DIM}received${RESET} →  ${BOLD}chars${RESET}`,
      RULE,
    ]);

    t.type(0x1b);
    t.type(0x0d);
    await wait(70);
    expect(fake.out.at(-1)).toBe(
      `  ${DIM}${'ESC CR'.padEnd(8)}${RESET} →  ${BOLD}"\\u001b\\r"${RESET}`,
    );
    expect(fake.out).toHaveLength(4);

    t.type(0x61);
    await wait(70);
    expect(fake.out.at(-1)).toBe(`  ${DIM}${'a'.padEnd(8)}${RESET} →  ${BOLD}"a"${RESET}`);
    expect(fake.exits).toEqual([]);
  });

  test('q leaves raw mode, removes the restore hooks, prints the rule and exits 0', () => {
    const t = fakeTty();
    const fake = fakeCliDeps({}, { tty: t.tty });
    key(fake.deps);
    t.type(0x71);
    expect(t.rawMode).toEqual([true, false]);
    expect(t.hooks).toEqual([
      ['once', 'exit'],
      ['once', 'SIGINT'],
      ['once', 'SIGTERM'],
      ['off', 'exit'],
      ['off', 'SIGINT'],
      ['off', 'SIGTERM'],
    ]);
    expect(t.restorers.size).toBe(0);
    expect(fake.out.at(-1)).toBe(`${RULE}\n`);
    expect(fake.exits).toEqual([0]);
  });

  test('q inside a longer chunk is an ordinary byte', async () => {
    const t = fakeTty();
    const fake = fakeCliDeps({}, { tty: t.tty });
    key(fake.deps);
    t.type(0x71, 0x71);
    await wait(70);
    expect(fake.exits).toEqual([]);
    expect(fake.out.at(-1)).toBe(`  ${DIM}${'q q'.padEnd(8)}${RESET} →  ${BOLD}"qq"${RESET}`);
  });

  test('the restore hook leaves raw mode, and ignores a terminal that refuses', () => {
    const t = fakeTty();
    key(fakeCliDeps({}, { tty: t.tty }).deps);
    t.restorers.get('SIGINT')?.();
    expect(t.rawMode).toEqual([true, false]);
    t.tty.setRawMode = () => {
      throw new Error('not a tty');
    };
    expect(() => t.restorers.get('exit')?.()).not.toThrow();
  });
});

describe('processKeyTty', () => {
  test('reads isTTY from process.stdin when asked', () => {
    const tty = processKeyTty();
    const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      expect(tty.isTTY).toBe(true);
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      expect(tty.isTTY).toBe(false);
    } finally {
      if (saved) Object.defineProperty(process.stdin, 'isTTY', saved);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  });

  test('forwards to process.stdin and process', () => {
    const stdin = process.stdin as typeof process.stdin & { setRawMode?: (on: boolean) => void };
    const savedSetRawMode = stdin.setRawMode;
    const rawMode: boolean[] = [];
    stdin.setRawMode = (on: boolean) => {
      rawMode.push(on);
      return process.stdin;
    };
    const resume = spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
    const on = spyOn(process.stdin, 'on').mockImplementation(() => process.stdin);
    const once = spyOn(process, 'once').mockImplementation(() => process);
    const off = spyOn(process, 'removeListener').mockImplementation(() => process);
    try {
      const tty = processKeyTty();
      const listener = () => {};
      tty.setRawMode(true);
      tty.resume();
      tty.onData(listener);
      tty.once('SIGTERM', listener);
      tty.off('SIGTERM', listener);
      expect(rawMode).toEqual([true]);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(on).toHaveBeenCalledWith('data', listener);
      expect(once).toHaveBeenCalledWith('SIGTERM', listener);
      expect(off).toHaveBeenCalledWith('SIGTERM', listener);
    } finally {
      stdin.setRawMode = savedSetRawMode;
      resume.mockRestore();
      on.mockRestore();
      once.mockRestore();
      off.mockRestore();
    }
  });
});
