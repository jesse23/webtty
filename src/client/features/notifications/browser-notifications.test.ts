import { describe, expect, test } from 'bun:test';
import { activates, browserNotifications } from './browser-notifications';

/** A stand-in for the browser's Notification constructor that logs what it is asked. */
function fakeNotification(permission: NotificationPermission = 'default') {
  const created: FakeNotification[] = [];
  class FakeNotification {
    static permission = permission;
    static requests = 0;
    static async requestPermission(): Promise<NotificationPermission> {
      FakeNotification.requests++;
      FakeNotification.permission = 'granted';
      return 'granted';
    }
    onclick: ((event: Event) => unknown) | null = null;
    closed = false;
    constructor(
      readonly title: string,
      readonly options: { body: string; tag: string },
    ) {
      created.push(this);
    }
    close(): void {
      this.closed = true;
    }
  }
  return { FakeNotification, created };
}

describe('browserNotifications', () => {
  test('is undefined without the API', () => {
    expect(browserNotifications(undefined)).toBeUndefined();
  });

  test('reads the permission live and asks the constructor for it', async () => {
    const { FakeNotification } = fakeNotification('default');
    const api = browserNotifications(FakeNotification);
    expect(api?.permission()).toBe('default');
    expect(await api?.requestPermission()).toBe('granted');
    expect(FakeNotification.requests).toBe(1);
    expect(api?.permission()).toBe('granted');
  });

  test('shows a notification with its body and tag, and wires the click', () => {
    const { FakeNotification, created } = fakeNotification('granted');
    let clicks = 0;
    const shown = browserNotifications(FakeNotification)?.show(
      'vim',
      { body: 'done', tag: 'main\0vim' },
      () => clicks++,
    );
    expect(created).toHaveLength(1);
    expect([created[0].title, created[0].options]).toEqual([
      'vim',
      { body: 'done', tag: 'main\0vim' },
    ]);
    created[0].onclick?.(new Event('click'));
    expect(clicks).toBe(1);
    shown?.close();
    expect(created[0].closed).toBe(true);
  });

  test("defaults to the page's Notification, which Bun does not have", () => {
    expect(browserNotifications()).toBeUndefined();
  });
});

describe('activates', () => {
  test('follows navigator.userActivation where there is one', () => {
    expect(activates({ key: 'a' }, { isActive: false })).toBe(false);
    expect(activates({ key: 'Escape' }, { isActive: true })).toBe(true);
  });

  test('without it, every input but Esc', () => {
    expect(activates({ key: 'Escape' }, undefined)).toBe(false);
    expect(activates({ key: 'a' }, undefined)).toBe(true);
    expect(activates({}, undefined)).toBe(true);
  });
});
