import { describe, expect, test } from 'bun:test';
import { createShortcutCommands, type ShortcutAction } from './shortcut-commands';

/** What a command did with its key, as the tests read it. */
type Settled = 'consume' | 'stop' | 'pass';

/** The commands on a logging host whose answers the case sets. */
function setup(state: { barOpen?: boolean; done?: boolean; clipboard?: boolean } = {}) {
  const log: string[] = [];
  /** Logs `call` and answers `result`. */
  const answer = (call: string, result: boolean) => () => {
    log.push(call);
    return result;
  };
  const commands = createShortcutCommands({
    find: {
      isOpen: state.barOpen ?? false,
      open: () => log.push('open'),
      close: () => log.push('close'),
      go: (direction) => log.push(`go:${direction}`),
    },
    jumpToPrompt: (delta) => log.push(`jump:${delta}`),
    copySelection: answer('copy', state.done ?? false),
    clearScreen: answer('clear', state.done ?? false),
    pasteFromClipboard: answer('paste', state.clipboard ?? false),
  });
  /** Runs `action`; the log gets the key's `consume` or `stop` in call order. */
  const run = (action: ShortcutAction, performable = true): Settled => {
    let settled: Settled = 'pass';
    commands[action](
      { action, performable },
      {
        consume: () => {
          log.push('consume');
          settled = 'consume';
        },
        stop: () => {
          log.push('stop');
          settled = 'stop';
        },
      },
    );
    return settled;
  };
  return { log, run };
}

describe('createShortcutCommands', () => {
  test.each([true, false])('find opens the bar and consumes the key (bar open: %p)', (barOpen) => {
    const { log, run } = setup({ barOpen });
    expect(run('find', false)).toBe('consume');
    expect(log).toEqual(['consume', 'open']);
  });

  test.each<[ShortcutAction, string]>([
    ['findClose', 'close'],
    ['findNext', 'go:next'],
    ['findPrevious', 'go:previous'],
  ])('%s acts while the bar is open', (action, call) => {
    const { log, run } = setup({ barOpen: true });
    expect(run(action)).toBe('consume');
    expect(log).toEqual(['consume', call]);
  });

  test.each<ShortcutAction>(['findClose', 'findNext', 'findPrevious'])(
    '%s is the app’s while the bar is closed (ADR 055)',
    (action) => {
      const { log, run } = setup({ barOpen: false });
      expect(run(action)).toBe('pass');
      expect(log).toEqual([]);
    },
  );

  test.each<[ShortcutAction, string]>([
    ['promptPrevious', 'jump:-1'],
    ['promptNext', 'jump:1'],
  ])('%s jumps and is consumed either way (ADR 057)', (action, call) => {
    const { log, run } = setup();
    expect(run(action, false)).toBe('consume');
    expect(log).toEqual([call, 'consume']);
  });

  test.each<[boolean, Settled]>([
    [true, 'consume'],
    [false, 'stop'],
  ])('paste with a readable clipboard %p → %s', (clipboard, outcome) => {
    const { log, run } = setup({ clipboard });
    expect(run('paste', false)).toBe(outcome);
    expect(log).toEqual(['paste', outcome]);
  });

  test.each<[ShortcutAction, boolean, boolean, Settled]>([
    ['copy', true, true, 'consume'],
    ['copy', false, true, 'pass'],
    ['copy', false, false, 'consume'],
    ['copy', true, false, 'consume'],
    ['clear', true, true, 'consume'],
    ['clear', false, true, 'pass'],
    ['clear', false, false, 'consume'],
  ])('%s done %p, performable %p → %s', (action, done, performable, outcome) => {
    const { log, run } = setup({ done });
    expect(run(action, performable)).toBe(outcome);
    expect(log).toEqual(outcome === 'pass' ? [action] : [action, outcome]);
  });
});
