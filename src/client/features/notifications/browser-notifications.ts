// The browser's side of desktop notifications (adapter, ADR 056): the Notification API
// behind the notifier's narrow NotificationApi, and whether an input gave the page the
// user activation a permission prompt needs.

import type { NotificationApi } from './desktop-notifier';

/** The part of the browser's `Notification` constructor the adapter uses. */
export interface NotificationConstructor {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  new (
    title: string,
    options: { body: string; tag: string },
  ): { onclick: ((event: Event) => unknown) | null; close(): void };
}

/**
 * The browser's Notification API as the notifier sees it, or undefined where there is
 * none (http, iOS Safari). `ctor` is the global `Notification` in the page.
 */
export function browserNotifications(
  ctor: NotificationConstructor | undefined = typeof Notification === 'undefined'
    ? undefined
    : Notification,
): NotificationApi | undefined {
  if (!ctor) return undefined;
  return {
    permission: () => ctor.permission,
    requestPermission: () => ctor.requestPermission(),
    show: (title, options, onClick) => {
      const notification = new ctor(title, options);
      notification.onclick = onClick;
      return notification;
    },
  };
}

/**
 * Whether a key or click gave the page user activation, so a permission request from
 * it can prompt. Esc and keys the browser reserves do not (HTML's activation-triggering
 * input events); `navigator.userActivation` knows, and without it only Esc is ruled out.
 */
export function activates(
  event: { key?: string },
  activation: { readonly isActive: boolean } | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.userActivation,
): boolean {
  if (activation) return activation.isActive;
  return event.key !== 'Escape';
}
