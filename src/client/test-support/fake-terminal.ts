// The slice of the vendored Terminal that webtty's features use, as a fake (test fake,
// ADR 064): its emitters can be fired by the test, its subscriptions are logged in order
// for the client root's order test, and its commands are recorded instead of run.

import {
  type DesktopNotification,
  EventEmitter,
  type IEvent,
  type Terminal,
} from '../vendor/ghostty-web';

/** What `onFindChange` reports, taken from the real terminal so the two cannot drift. */
export type FindState = Parameters<Parameters<Terminal['onFindChange']>[0]>[0];

/** What each terminal event a feature subscribes to carries, by its `on…` name. */
export interface TerminalEvents {
  onData: string;
  onResize: { cols: number; rows: number };
  onBell: undefined;
  onTitleChange: string;
  onScroll: number;
  onPasteRequest: undefined;
  onClipboardWrite: string;
  onDesktopNotification: DesktopNotification;
  onFindChange: FindState;
}

/** The name of a terminal event. */
export type TerminalEventName = keyof TerminalEvents;

/** A fake `Terminal`: fire its events, read what was written, called and subscribed. */
export class FakeTerminal {
  cols = 80;
  rows = 24;
  viewportY = 0;
  options: Record<string, unknown> = {};
  /** Everything passed to `write`, in order. */
  readonly written: (string | Uint8Array)[] = [];
  /** Every command called, as `name` or `name:arg`, in order. */
  readonly calls: string[] = [];
  /** Every event subscription, by event name, in order. */
  readonly subscriptions: TerminalEventName[] = [];

  private readonly emitters = new Map<TerminalEventName, EventEmitter<unknown>>();

  readonly onData = this.subscribe('onData');
  readonly onResize = this.subscribe('onResize');
  readonly onBell = this.subscribe('onBell');
  readonly onTitleChange = this.subscribe('onTitleChange');
  readonly onScroll = this.subscribe('onScroll');
  readonly onPasteRequest = this.subscribe('onPasteRequest');
  readonly onClipboardWrite = this.subscribe('onClipboardWrite');
  readonly onDesktopNotification = this.subscribe('onDesktopNotification');
  readonly onFindChange = this.subscribe('onFindChange');

  /** Fires `name` with `arg`, as the real terminal would. */
  fire<K extends TerminalEventName>(
    name: K,
    ...arg: TerminalEvents[K] extends undefined ? [] : [TerminalEvents[K]]
  ): void {
    this.emitter(name).fire(arg[0]);
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.written.push(data);
    callback?.();
  }

  /** The written strings joined, for asserting on text output. */
  get output(): string {
    return this.written.filter((chunk) => typeof chunk === 'string').join('');
  }

  resize(cols: number, rows: number): void {
    this.calls.push(`resize:${cols}x${rows}`);
    this.cols = cols;
    this.rows = rows;
    this.emitter('onResize').fire({ cols, rows });
  }

  paste(text: string): void {
    this.calls.push(`paste:${text}`);
  }

  find(needle: string): void {
    this.calls.push(`find:${needle}`);
  }

  findNext(): boolean {
    this.calls.push('findNext');
    return true;
  }

  findPrevious(): boolean {
    this.calls.push('findPrevious');
    return true;
  }

  endFind(): void {
    this.calls.push('endFind');
  }

  focus(): void {
    this.calls.push('focus');
  }

  reset(): void {
    this.calls.push('reset');
  }

  scrollToBottom(): void {
    this.calls.push('scrollToBottom');
    this.viewportY = 0;
  }

  /** The fake typed as the real class, for code under test that takes a `Terminal`. */
  asTerminal(): Terminal {
    // The fake covers the members features use, not the whole Terminal class.
    return this as unknown as Terminal;
  }

  private emitter(name: TerminalEventName): EventEmitter<unknown> {
    let emitter = this.emitters.get(name);
    if (!emitter) {
      emitter = new EventEmitter<unknown>();
      this.emitters.set(name, emitter);
    }
    return emitter;
  }

  private subscribe<K extends TerminalEventName>(name: K): IEvent<TerminalEvents[K]> {
    return (listener) => {
      this.subscriptions.push(name);
      return this.emitter(name).event(listener as (arg: unknown) => void);
    };
  }
}
