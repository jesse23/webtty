import { describe, expect, test } from 'bun:test';
import { TabTitle } from './tab-title';

function setup(bellTitle = true) {
  const titles: string[] = [];
  const replay = { active: false };
  const tab = new TabTitle('main', bellTitle, replay, (t) => titles.push(t));
  const last = () => titles[titles.length - 1];
  return { tab, replay, titles, last };
}

describe('TabTitle', () => {
  test("shows the program's title, or the session id while it has none", () => {
    const { tab, last } = setup();
    expect(last()).toBe('main | webtty');
    expect(tab.name).toBe('main');
    tab.title('vim README.md');
    expect(last()).toBe('vim README.md | webtty');
    expect(tab.name).toBe('vim README.md');
    tab.title('');
    expect(last()).toBe('main | webtty');
  });

  test('a bell marks the title until the terminal is attended', () => {
    const { tab, titles, last } = setup();
    tab.title('make');
    tab.bell();
    expect(last()).toBe('🔔 make | webtty');
    // A title change keeps the mark; a second bell changes nothing.
    tab.title('done');
    const count = titles.length;
    tab.bell();
    expect(titles).toHaveLength(count);
    expect(last()).toBe('🔔 done | webtty');
    expect(tab.name).toBe('done');
    tab.attended();
    expect(last()).toBe('done | webtty');
    // Attending again changes nothing.
    tab.attended();
    expect(titles).toHaveLength(count + 1);
  });

  test('ignores bells while the replay is active', () => {
    const { tab, replay, last } = setup();
    replay.active = true;
    tab.bell();
    expect(last()).toBe('main | webtty');
    replay.active = false;
    tab.bell();
    expect(last()).toBe('🔔 main | webtty');
  });

  test('applies titles from the replay', () => {
    const { tab, replay, last } = setup();
    replay.active = true;
    tab.title('htop');
    expect(last()).toBe('htop | webtty');
  });

  test('with bellTitle off, a bell changes nothing', () => {
    const { tab, titles } = setup(false);
    tab.bell();
    expect(titles).toEqual(['main | webtty']);
  });
});
