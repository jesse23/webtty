/** A desktop notification the program asked for (OSC 9: no title; OSC 777). */
export interface NotificationRequest {
  title: string;
  body: string;
}

/** A notification on screen. */
export interface ShownNotification {
  close(): void;
}

/** The part of the browser's Notification API the notifier uses. */
export interface NotificationApi {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Shows a notification as plain text; throws where the browser cannot. */
  show(
    title: string,
    options: { body: string; tag: string },
    onClick: () => void,
  ): ShownNotification;
}

/** What the notifier needs from the page. */
export interface NotifierHost {
  /** Whether the terminal has focus, in a focused window (ADR 053). */
  focused(): boolean;
  /** The tab's name: the program's title, or the session id. */
  name(): string;
  /** Marks the tab title, as a bell does: the fallback. */
  mark(): void;
  /** Brings the window and the terminal forward, for a click on a notification. */
  focus(): void;
}

/** At most one notification a second, as Ghostty does. */
export const NOTIFY_INTERVAL_MS = 1000;

/** The same title and body at most once in five seconds, as Ghostty does. */
export const NOTIFY_REPEAT_MS = 5000;

/** The browser's Notification API, or undefined where there is none (http, iOS Safari). */
export function browserNotifications(): NotificationApi | undefined {
  if (typeof Notification === 'undefined') return undefined;
  return {
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    show: (title, options, onClick) => {
      const notification = new Notification(title, options);
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

/**
 * Shows a program's desktop notifications (OSC 9, OSC 777) as Ghostty on macOS does
 * (ADR 056): not for the replay, at most one a second and the same one once in five
 * seconds, and only while the terminal is not focused. Without permission, or without
 * the API, the tab title is marked as for a bell instead.
 *
 * Permission is asked on the next key or click in the tab that activates the page
 * (not Esc) after the first notification while it is undecided, once per page load,
 * never on load: browsers want a user gesture for the prompt.
 */
export class DesktopNotifier {
  private last: { at: number; key: string } | null = null;
  private askOnInput = false;
  private asked = false;
  private readonly shown = new Set<ShownNotification>();
  private readonly logged = new Set<string>();

  constructor(
    private readonly api: NotificationApi | undefined,
    private readonly sessionId: string,
    private readonly replay: { readonly active: boolean },
    private readonly host: NotifierHost,
    private readonly log: (message: string) => void = (message) => console.warn(message),
  ) {}

  /** The program asked for a notification at `now` (ms). */
  notify(request: NotificationRequest, now: number): void {
    if (this.replay.active) return;
    if (!this.asked && this.api?.permission() === 'default') this.askOnInput = true;
    const key = `${request.title}\0${request.body}`;
    if (this.last) {
      const since = now - this.last.at;
      if (since < NOTIFY_INTERVAL_MS) return;
      if (key === this.last.key && since < NOTIFY_REPEAT_MS) return;
    }
    this.last = { at: now, key };
    if (this.host.focused()) return;
    if (!this.show(request.title || this.host.name(), request.body, key)) this.host.mark();
  }

  /**
   * The user pressed a key or clicked in this tab: a gesture to ask permission with if
   * it `activated` the page. One that did not (Esc) leaves the request for the next.
   */
  userInput(activated: boolean): void {
    if (!this.askOnInput || !this.api || !activated) return;
    this.askOnInput = false;
    this.asked = true;
    if (this.api.permission() !== 'default') return;
    this.api.requestPermission().catch(() => {});
  }

  /** The terminal gained focus or got a key: its notifications have been seen. */
  attended(): void {
    for (const notification of this.shown) notification.close();
    this.shown.clear();
  }

  private show(title: string, body: string, key: string): boolean {
    if (!this.api) {
      this.once(
        'api',
        'webtty: desktop notification shown in the tab title: no Notification API (needs https or localhost)',
      );
      return false;
    }
    if (this.api.permission() !== 'granted') {
      this.once(
        'permission',
        'webtty: desktop notification shown in the tab title: notifications are not allowed for this page',
      );
      return false;
    }
    try {
      // The tag replaces rather than stacks the same notification from another tab
      const notification = this.api.show(title, { body, tag: `${this.sessionId}\0${key}` }, () => {
        this.host.focus();
        notification.close();
        this.shown.delete(notification);
      });
      this.shown.add(notification);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.once('refused', `webtty: the browser refused a desktop notification: ${reason}`);
      return false;
    }
  }

  private once(key: string, message: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(message);
  }
}
