// Derived from coder/ghostty-web lib/event-emitter.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// A typed event source (object): the terminal and the selection manager expose each of
// their xterm-style `onX` events as one emitter's `event` (ADR 061).

import type { IDisposable, IEvent } from './interfaces';

/**
 * One event's listeners, called in subscription order. `fire` walks the live list, so a
 * listener that unsubscribes itself while it runs makes the next listener miss that fire
 * (as upstream does; pinned by vendor/tests/core/event-emitter.test.ts).
 */
export class EventEmitter<T> {
  private listeners: Array<(arg: T) => void> = [];

  /** Calls every listener with `arg`. */
  fire(arg: T): void {
    for (const listener of this.listeners) {
      listener(arg);
    }
  }

  /** Subscribes a listener; the returned disposable removes that one subscription. */
  event: IEvent<T> = (listener): IDisposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  /** Drops every listener, for the owner's own `dispose`. */
  dispose(): void {
    this.listeners = [];
  }
}
