import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { type RecordingTarget, recordListeners } from '../../test-support/recording-target';
import type { NotificationApi } from './desktop-notifier';
import { installNotifications, type NotificationsDeps } from './notifications-feature';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** A recording NotificationApi whose permission the test sets. */
function fakeApi(permission: NotificationPermission = 'granted') {
  const log: string[] = [];
  const clicks: (() => void)[] = [];
  const api: NotificationApi = {
    permission: () => permission,
    requestPermission: async () => {
      log.push('request');
      return permission;
    },
    show: (title, options, onClick) => {
      log.push(`show:${title}:${options.body}`);
      clicks.push(onClick);
      return { close: () => log.push(`close:${title}`) };
    },
  };
  return { api, log, clicks };
}

/** The feature installed on fakes; `log` records the API and the tab title in order. */
function setup(deps: Partial<NotificationsDeps> = {}, permission?: NotificationPermission) {
  fake = fakeContext();
  const container = recordListeners(fake.container, 'container');
  const doc = recordListeners(fake.dom.document, 'document');
  const { api, log, clicks } = fakeApi(permission);
  const replay = { active: false };
  let now = 10_000;
  const feature = installNotifications(fake.ctx, {
    sessionId: 'main',
    replay,
    title: {
      name: 'vim',
      bell: () => log.push('bell'),
      attended: () => log.push('title attended'),
    },
    notifications: api,
    userActivation: { isActive: true },
    now: () => now,
    ...deps,
  });
  const notify = (title = 'build', body = 'done') => {
    now += 10_000;
    fake.term.fire('onDesktopNotification', { title, body });
  };
  return { feature, container, doc, replay, log, clicks, notify };
}

/** Puts focus inside the terminal, as a click on its textarea does. */
function focusTerminal(): void {
  const textarea = fake.dom.document.createElement('textarea');
  fake.container.append(textarea);
  textarea.focus();
}

/** A window `keydown` for `name`, as the browser dispatches it. */
const key = (name: string) => new fake.dom.window.KeyboardEvent('keydown', { key: name });

const rows = (target: RecordingTarget) =>
  target.added.map(({ target, type, capture }) => ({ target, type, capture }));

describe('installNotifications', () => {
  test('adds its listeners in the SPEC order and subscribes once', () => {
    const { container, doc } = setup();
    expect(rows(fake.win)).toEqual([
      { target: 'window', type: 'keydown', capture: true },
      { target: 'window', type: 'mousedown', capture: true },
      { target: 'window', type: 'keydown', capture: true },
    ]);
    expect(rows(container)).toEqual([{ target: 'container', type: 'focusin', capture: false }]);
    expect(rows(doc)).toEqual([{ target: 'document', type: 'visibilitychange', capture: false }]);
    expect(fake.term.subscriptions).toEqual(['onDesktopNotification']);
  });

  test('shows a notification while the terminal is not focused; a click focuses it', () => {
    const { log, clicks, notify } = setup();
    notify('', 'done');
    expect(log).toEqual(['show:vim:done']);
    clicks[0]();
    expect(fake.win.calls).toEqual(['focus']);
    expect(fake.term.calls).toEqual(['focus']);
    expect(log).toEqual(['show:vim:done', 'close:vim']);
  });

  test('nothing while the terminal is focused, or for the replay', () => {
    const { log, replay, notify } = setup();
    replay.active = true;
    notify();
    replay.active = false;
    focusTerminal();
    notify();
    expect(log).toEqual([]);
  });

  test('without permission the tab title is marked instead', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const { log, notify } = setup({}, 'denied');
    notify();
    expect(log).toEqual(['bell']);
    warn.mockRestore();
  });

  test('asks permission on the next activating key or click, not on Esc without activation', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const first = setup({ userActivation: undefined }, 'default');
    first.notify();
    fake.win.dispatch(key('Escape'));
    expect(first.log).toEqual(['bell']);
    fake.win.dispatch(key('a'));
    expect(first.log).toEqual(['bell', 'request']);
    fake.dom.close();
    const second = setup({ userActivation: { isActive: true } }, 'default');
    second.notify();
    fake.win.dispatch({ type: 'mousedown' });
    expect(second.log).toEqual(['bell', 'request']);
    warn.mockRestore();
  });

  test('closes what it showed on focusin, a window key, or the tab shown while focused', () => {
    const { log, notify } = setup();
    notify('a');
    fake.container.dispatchEvent(new fake.dom.window.FocusEvent('focusin'));
    notify('b');
    fake.win.dispatch(key('a'));
    expect(log).toEqual(['show:a:done', 'close:a', 'show:b:done', 'close:b']);
    log.length = 0;
    // Shown again with focus elsewhere in the page: not attended
    notify('c');
    fake.setVisibility('visible');
    expect(log).toEqual(['show:c:done']);
    fake.container.dispatchEvent(new fake.dom.window.FocusEvent('focusin'));
    log.length = 0;
    // The tab hidden with focus in the terminal, then shown again
    focusTerminal();
    fake.setVisibility('hidden');
    notify('d');
    fake.setVisibility('visible');
    expect(log).toEqual(['show:d:done', 'title attended', 'close:d']);
  });

  test('dispose removes everything it added; twice is a no-op', () => {
    const { feature, container, doc, log, notify } = setup();
    feature.dispose();
    feature.dispose();
    expect(fake.win.active).toEqual([]);
    expect(fake.win.removed).toHaveLength(3);
    expect(container.active).toEqual([]);
    expect(doc.active).toEqual([]);
    notify();
    expect(log).toEqual([]);
  });
});
