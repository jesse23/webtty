import { describe, expect, test } from 'bun:test';
import { DEFAULT_FLOW_LIMITS } from '../server/flow';
import { REPLAY_PIECE, REPLAY_QUIET_MS, TabTitle } from './tab-title';

function setup(bellTitle = true) {
  const titles: string[] = [];
  const tab = new TabTitle('main', bellTitle, (t) => titles.push(t));
  const last = () => titles[titles.length - 1];
  return { tab, titles, last };
}

/** Connects and parses a one-message replay, then a live message arrives. */
function afterReplay(tab: TabTitle): void {
  tab.connected();
  tab.output(100, 0);
  tab.parsed(0);
  tab.output(10, 0);
}

describe('TabTitle', () => {
  test("shows the program's title, or the session id while it has none", () => {
    const { tab, last } = setup();
    expect(last()).toBe('main | webtty');
    tab.title('vim README.md');
    expect(last()).toBe('vim README.md | webtty');
    tab.title('');
    expect(last()).toBe('main | webtty');
  });

  test('a bell marks the title until the terminal is attended', () => {
    const { tab, titles, last } = setup();
    afterReplay(tab);
    tab.title('make');
    tab.bell();
    expect(last()).toBe('🔔 make | webtty');
    // A title change keeps the mark; a second bell changes nothing.
    tab.title('done');
    const count = titles.length;
    tab.bell();
    expect(titles).toHaveLength(count);
    expect(last()).toBe('🔔 done | webtty');
    tab.attended();
    expect(last()).toBe('done | webtty');
    // Attending again changes nothing.
    tab.attended();
    expect(titles).toHaveLength(count + 1);
  });

  test('ignores the bells of the replay, through its last piece', () => {
    const { tab, last } = setup();
    tab.connected();
    // Full pieces, the second one short of a surrogate pair, then the shorter last one.
    for (const chars of [REPLAY_PIECE, REPLAY_PIECE - 1, 10]) {
      tab.output(chars, 0);
      tab.bell();
      tab.parsed(0);
    }
    expect(last()).toBe('main | webtty');
    // The next message is live output, however soon it comes.
    tab.output(REPLAY_PIECE, 0);
    tab.bell();
    expect(last()).toBe('🔔 main | webtty');
  });

  test('a replay ending on a full piece is over when the output pauses after it', () => {
    const { tab, last } = setup();
    tab.connected();
    tab.output(REPLAY_PIECE, 0);
    // Slow to parse: the pause counts from the end of the parse.
    tab.parsed(REPLAY_QUIET_MS);
    tab.output(10, REPLAY_QUIET_MS * 2 - 1);
    tab.bell();
    tab.parsed(REPLAY_QUIET_MS * 2 - 1);
    expect(last()).toBe('main | webtty');
    // The short message ended it too: the next is live, as is one after a pause.
    tab.output(10, REPLAY_QUIET_MS * 2);
    tab.bell();
    expect(last()).toBe('🔔 main | webtty');

    const other = setup();
    other.tab.connected();
    other.tab.output(REPLAY_PIECE, 0);
    other.tab.parsed(0);
    other.tab.output(10, REPLAY_QUIET_MS);
    other.tab.bell();
    expect(other.last()).toBe('🔔 main | webtty');
  });

  test('a reconnect replays again, and its bells are ignored', () => {
    const { tab, last } = setup();
    afterReplay(tab);
    tab.connected();
    // The first message is the replay, however long after the connect it arrives.
    tab.output(10, REPLAY_QUIET_MS * 10);
    tab.bell();
    expect(last()).toBe('main | webtty');
  });

  test("the replay's piece size is the server's", () => {
    expect(REPLAY_PIECE).toBe(DEFAULT_FLOW_LIMITS.chunk);
  });

  test('applies titles from the replay', () => {
    const { tab, last } = setup();
    tab.connected();
    tab.output(10, 0);
    tab.title('htop');
    expect(last()).toBe('htop | webtty');
  });

  test('with bellTitle off, a bell changes nothing', () => {
    const { tab, titles } = setup(false);
    afterReplay(tab);
    tab.bell();
    expect(titles).toEqual(['main | webtty']);
  });
});
