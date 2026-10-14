// webtty (ADR 053, ADR 061), not from upstream.
// Where keyboard focus is (object): it keeps focus off the container, follows it into and
// out of the terminal, and sends Ghostty's focus reports while the app has mode 1004 on
// (ADR 053). Moved out of terminal.ts (ADR 061).

import {
  type Disposable,
  DisposableStore,
  type ListenerTarget,
  listen,
} from '../lifecycle/disposable-store';
import type { FocusHost } from './host-types';
import { FOCUS_EVENT_MODE } from './terminal-constants';

/** The window and document the tracker listens on and reads, injected so tests pass fakes. */
export interface FocusEnv {
  readonly window: ListenerTarget;
  readonly document: ListenerTarget & Pick<Document, 'activeElement' | 'visibilityState' | 'hasFocus'>;
}

/** The page's own window and document, read when the terminal opens. */
export function browserFocusEnv(): FocusEnv {
  return { window, document };
}

/**
 * Terminal focus for mode 1004: keyboard focus inside the container in a focused window.
 * A report goes out on each change while the mode is on, and once when a write turns it on.
 */
export class FocusTracker implements Disposable {
  private focused = false;
  // Whether mode 1004 was on after the last write
  private reporting = false;
  private env?: FocusEnv;
  private containerListeners?: DisposableStore;

  constructor(private readonly host: FocusHost) {}

  /**
   * Adds the focus listeners, in the order Terminal.open() always added them: the
   * container's redirect, the window's, then the four that follow focus.
   */
  attach(container: HTMLElement, env: FocusEnv = browserFocusEnv()): void {
    this.env = env;
    const listeners = new DisposableStore();
    this.containerListeners = listeners;
    // Never let the container hold focus, or the browser writes IME composition
    // text into it; input goes to the textarea. This covers clicks in the padding,
    // tab focus and focus(). (webtty)
    listeners.add(listen(container, 'focusin', this.redirect));
    // focus() on a background window moves activeElement without a focusin; catch
    // the container still holding focus when the window comes back. (webtty)
    // leaks until ADR 065
    env.window.addEventListener('focus', this.windowFocused);
    // Terminal focus for mode 1004: a window blur or focus usually reaches the focused
    // element as focusout / focusin too, but Chrome switching tabs only changes the
    // page's visibility, so blur and visibility are watched as well. (webtty, ADR 053)
    listeners.add(listen(container, 'focusin', this.gained));
    listeners.add(listen(container, 'focusout', this.lost));
    // leaks until ADR 065
    env.window.addEventListener('blur', this.windowBlurred);
    // leaks until ADR 065
    env.document.addEventListener('visibilitychange', this.visibilityChanged);
  }

  /** Removes the container's listeners; the window's and document's stay (ADR 065). */
  dispose(): void {
    this.containerListeners?.dispose();
  }

  /**
   * Removes the window's and document's listeners. Terminal calls it only while open,
   * which its teardown never is, so today they leak (ADR 065).
   */
  detachWindow(): void {
    if (!this.env) return;
    this.env.window.removeEventListener('focus', this.windowFocused);
    this.env.window.removeEventListener('blur', this.windowBlurred);
    this.env.document.removeEventListener('visibilitychange', this.visibilityChanged);
  }

  /** After a write: Ghostty reports the focus when the app turns mode 1004 on. */
  followMode(): void {
    const reporting = this.host.engine()!.getMode(FOCUS_EVENT_MODE);
    if (reporting && !this.reporting) this.report();
    this.reporting = reporting;
  }

  /** A new engine starts with mode 1004 off. */
  reset(): void {
    this.reporting = false;
  }

  /**
   * Sends the current focus if mode 1004 is on, for a new connection to the app: reports
   * sent while there was none were dropped.
   */
  resync(): void {
    if (this.host.engine()?.getMode(FOCUS_EVENT_MODE)) this.report();
  }

  /** Sends focus that lands on the container itself to the textarea. (webtty) */
  private readonly redirect = (e: FocusEvent): void => {
    if (e.target === this.host.element()) this.host.textarea()?.focus();
  };

  private readonly windowFocused = (): void => {
    const element = this.host.element();
    if (element && this.env!.document.activeElement === element) this.host.textarea()?.focus();
  };

  /** Focus came into the container, or its window got focus back. */
  private readonly gained = (): void => {
    this.setFocused(true);
  };

  /**
   * Focus left the container, or its window lost focus (no `relatedTarget`). A move
   * inside it, the container passing focus on to the textarea, is not a change.
   */
  private readonly lost = (e: FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (next && this.host.element()?.contains(next)) return;
    this.setFocused(false);
  };

  /** The window lost focus: the terminal has none, whatever element is active. */
  private readonly windowBlurred = (): void => {
    this.setFocused(false);
  };

  /**
   * The tab was hidden or shown. Chrome fires no blur or focus for a tab switch, so the
   * focus is read again here.
   */
  private readonly visibilityChanged = (): void => {
    const doc = this.env!.document;
    const shown = doc.visibilityState === 'visible' && doc.hasFocus();
    this.setFocused(shown && !!this.host.element()?.contains(doc.activeElement));
  };

  private setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    if (this.host.engine()?.getMode(FOCUS_EVENT_MODE)) this.report();
  }

  /** Sends `CSI I` or `CSI O` for the current focus, encoded by Ghostty. */
  private report(): void {
    const engine = this.host.engine();
    if (this.host.disableStdin() || !engine) return;
    const report = new TextDecoder().decode(engine.encodeFocus(this.focused));
    if (report) this.host.send(report);
  }
}
