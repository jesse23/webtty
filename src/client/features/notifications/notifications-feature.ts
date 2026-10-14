// Wires a program's desktop notifications (OSC 9, OSC 777) to the DesktopNotifier
// (feature, ADR 053, ADR 056, ADR 060): shown while the terminal is not focused, the bell
// mark without permission, permission asked on the next key or click that activates the
// page (not Esc), and closed once the terminal is attended.

import type { ClientContext, Feature } from '../../app/client-context';
import { isTerminalFocused } from '../../app/platform';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import { activates } from './browser-notifications';
import { DesktopNotifier, type NotificationApi } from './desktop-notifier';

/** The tab title as the notifier uses it: its name, its bell mark, and clearing the mark. */
export interface TitleMark {
  readonly name: string;
  bell(): void;
  attended(): void;
}

/** What the notifications feature needs besides the context. */
export interface NotificationsDeps {
  sessionId: string;
  /** Whether the output is the replay, whose notifications are not new (ADR 053). */
  replay: { readonly active: boolean };
  /** The tab title: the notification's fallback title and mark, attended with the notifier. */
  title: TitleMark;
  /** The browser's Notification API; undefined where the page has none (http, iOS Safari). */
  notifications: NotificationApi | undefined;
  /** `navigator.userActivation`, where the browser has it (ADR 056). */
  userActivation?: { readonly isActive: boolean };
  /** The clock the rate limits read, `performance.now()` in the page. */
  now(): number;
}

/** The installed notifications; nothing to call, only to dispose. */
export type NotificationsFeature = Feature;

/**
 * Subscribes to `onDesktopNotification`; window capture `keydown` and `mousedown` are the
 * gesture to ask permission with; container `focusin`, document `visibilitychange` (title
 * too) and window capture `keydown` attend, in that order.
 */
export function installNotifications(
  ctx: ClientContext,
  deps: NotificationsDeps,
): NotificationsFeature {
  const { term, container, doc, win } = ctx;
  const { title, userActivation } = deps;
  const store = new DisposableStore();
  const focused = (): boolean => isTerminalFocused(doc, container);
  const notifier = new DesktopNotifier(deps.notifications, deps.sessionId, deps.replay, {
    focused,
    name: () => title.name,
    mark: () => title.bell(),
    focus: () => {
      win.focus();
      term.focus();
    },
  });
  store.add(term.onDesktopNotification((n) => notifier.notify(n, deps.now())));
  store.add(
    listen(
      win,
      'keydown',
      (e) => notifier.userInput(activates(e as KeyboardEvent, userActivation)),
      { capture: true },
    ),
  );
  store.add(
    listen(win, 'mousedown', () => notifier.userInput(activates({}, userActivation)), {
      capture: true,
    }),
  );
  store.add(listen(container, 'focusin', () => notifier.attended()));
  store.add(
    listen(doc, 'visibilitychange', () => {
      if (!focused()) return;
      title.attended();
      notifier.attended();
    }),
  );
  store.add(listen(win, 'keydown', () => notifier.attended(), { capture: true }));
  return { dispose: () => store.dispose() };
}
