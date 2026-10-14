import { describe, expect, test } from 'bun:test';
import {
  DesktopNotifier,
  NOTIFY_INTERVAL_MS,
  NOTIFY_REPEAT_MS,
  type NotificationApi,
} from './notifications';

interface Shown {
  title: string;
  body: string;
  tag: string;
  closed: boolean;
  click: () => void;
}

function setup(
  options: {
    permission?: NotificationPermission | 'none';
    focused?: boolean;
    throws?: boolean;
  } = {},
) {
  let permission = options.permission ?? 'granted';
  const shown: Shown[] = [];
  const requests: number[] = [];
  const logs: string[] = [];
  const api: NotificationApi | undefined =
    permission === 'none'
      ? undefined
      : {
          permission: () => permission as NotificationPermission,
          requestPermission: async () => {
            requests.push(1);
            permission = 'granted';
            return 'granted';
          },
          show: (title, { body, tag }, onClick) => {
            if (options.throws) throw new TypeError('Illegal constructor.');
            const n: Shown = { title, body, tag, closed: false, click: onClick };
            shown.push(n);
            return {
              close: () => {
                n.closed = true;
              },
            };
          },
        };
  const state = { focused: options.focused ?? false, marks: 0, focuses: 0 };
  const replay = { active: false };
  const notifier = new DesktopNotifier(
    api,
    'main',
    replay,
    {
      focused: () => state.focused,
      name: () => 'vim',
      mark: () => state.marks++,
      focus: () => state.focuses++,
    },
    (m) => logs.push(m),
  );
  return { notifier, shown, requests, logs, state, replay };
}

describe('DesktopNotifier', () => {
  test('shows a notification as plain text while the terminal is not focused', () => {
    const { notifier, shown, state } = setup();
    notifier.notify({ title: 'Build', body: '<b>passed</b>' }, 0);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Build', body: '<b>passed</b>' });
    expect(state.marks).toBe(0);
  });

  test("an OSC 9 notification, with no title, takes the tab's name", () => {
    const { notifier, shown } = setup();
    notifier.notify({ title: '', body: 'done' }, 0);
    expect(shown[0]).toMatchObject({ title: 'vim', body: 'done' });
  });

  test('tags it with the session, title and body, so another tab replaces it', () => {
    const { notifier, shown } = setup();
    notifier.notify({ title: 't', body: 'b' }, 0);
    expect(shown[0].tag).toBe('main\0t\0b');
  });

  test('shows nothing while the terminal is focused, as Ghostty on macOS', () => {
    const { notifier, shown, state } = setup({ focused: true });
    notifier.notify({ title: 't', body: 'b' }, 0);
    expect(shown).toHaveLength(0);
    expect(state.marks).toBe(0);
  });

  test('ignores notifications in the replay', () => {
    const { notifier, shown, requests, state, replay } = setup({ permission: 'default' });
    replay.active = true;
    notifier.notify({ title: 't', body: 'b' }, 0);
    notifier.userInput();
    expect(shown).toHaveLength(0);
    expect(state.marks).toBe(0);
    // Nor does a replayed one arm the permission prompt.
    replay.active = false;
    notifier.userInput();
    expect(requests).toHaveLength(0);
  });

  test('one a second, and the same one once in five seconds', () => {
    const { notifier, shown } = setup();
    notifier.notify({ title: '', body: 'a' }, 0);
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS - 1);
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS);
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS * 2);
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS + NOTIFY_REPEAT_MS);
    expect(shown.map((n) => n.body)).toEqual(['a', 'b', 'b']);
  });

  test('a click focuses the terminal and closes it; attending closes the rest', () => {
    const { notifier, shown, state } = setup();
    notifier.notify({ title: '', body: 'a' }, 0);
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS);
    shown[0].click();
    expect(state.focuses).toBe(1);
    expect(shown.map((n) => n.closed)).toEqual([true, false]);
    notifier.attended();
    expect(shown.map((n) => n.closed)).toEqual([true, true]);
  });

  test('asks for permission on the next input after the first notification, once', async () => {
    const { notifier, shown, requests, state } = setup({ permission: 'default' });
    // Never before a notification.
    notifier.userInput();
    expect(requests).toHaveLength(0);
    notifier.notify({ title: '', body: 'a' }, 0);
    // Undecided: the tab title is marked instead.
    expect(shown).toHaveLength(0);
    expect(state.marks).toBe(1);
    notifier.userInput();
    notifier.userInput();
    expect(requests).toHaveLength(1);
    await Promise.resolve();
    // Granted: the next one shows.
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS);
    expect(shown.map((n) => n.body)).toEqual(['b']);
  });

  test('a notification while focused arms the prompt too', () => {
    const { notifier, requests } = setup({ permission: 'default', focused: true });
    notifier.notify({ title: '', body: 'a' }, 0);
    notifier.userInput();
    expect(requests).toHaveLength(1);
  });

  test('denied: never asks, and marks the tab title', () => {
    const { notifier, requests, shown, state, logs } = setup({ permission: 'denied' });
    notifier.notify({ title: '', body: 'a' }, 0);
    notifier.userInput();
    notifier.notify({ title: '', body: 'b' }, NOTIFY_INTERVAL_MS);
    expect(requests).toHaveLength(0);
    expect(shown).toHaveLength(0);
    expect(state.marks).toBe(2);
    expect(logs).toHaveLength(1);
  });

  test('no Notification API, or one that throws: marks the tab title', () => {
    const none = setup({ permission: 'none' });
    none.notifier.notify({ title: '', body: 'a' }, 0);
    none.notifier.userInput();
    expect(none.state.marks).toBe(1);
    expect(none.logs).toHaveLength(1);

    const throws = setup({ throws: true });
    throws.notifier.notify({ title: '', body: 'a' }, 0);
    expect(throws.state.marks).toBe(1);
    expect(throws.logs[0]).toContain('Illegal constructor.');
  });
});
