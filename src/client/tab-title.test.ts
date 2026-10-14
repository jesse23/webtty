import { describe, expect, test } from 'bun:test';
import { REPLAY_QUIET_MS, TabTitle } from './tab-title';

function setup(bellTitle = true) {
  const titles: string[] = [];
  const tab = new TabTitle('main', bellTitle, (t) => titles.push(t));
  const last = () => titles[titles.length - 1];
  return { tab, titles, last };
}

/** Connects and parses one replay message at time 0, then the replay is over at `gap`. */
function afterReplay(tab: TabTitle, gap = REPLAY_QUIET_MS): void {
  tab.connected();
  tab.output(0);
  tab.output(gap);
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

  test('ignores the bells of the replay, until the output pauses', () => {
    const { tab, last } = setup();
    tab.connected();
    tab.output(0);
    tab.bell();
    // The replay's messages arrive back to back.
    tab.output(REPLAY_QUIET_MS - 1);
    tab.bell();
    tab.output(REPLAY_QUIET_MS * 2 - 2);
    tab.bell();
    expect(last()).toBe('main | webtty');
    // A message after a pause is live output.
    tab.output(REPLAY_QUIET_MS * 3);
    tab.bell();
    expect(last()).toBe('🔔 main | webtty');
  });

  test('a reconnect replays again, and its bells are ignored', () => {
    const { tab, last } = setup();
    afterReplay(tab);
    tab.connected();
    // The first message is the replay, however long after the connect it arrives.
    tab.output(REPLAY_QUIET_MS * 10);
    tab.bell();
    expect(last()).toBe('main | webtty');
  });

  test('applies titles from the replay', () => {
    const { tab, last } = setup();
    tab.connected();
    tab.output(0);
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
