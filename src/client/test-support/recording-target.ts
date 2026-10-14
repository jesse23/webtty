// An event target that records every listener added and removed, with its options (test
// fake, ADR 064). Listener-order and teardown tests compare its log with the SPEC's tables;
// dispatch() calls the live listeners, so it also stands in for a window or an element.

import type { ListenerTarget } from '../vendor/ghostty-web';

/** One addEventListener or removeEventListener call, as the order and teardown tests read it. */
export interface ListenerRecord {
  target: string;
  type: string;
  capture: boolean;
  passive?: boolean;
  once?: boolean;
  listener: EventListenerOrEventListenerObject;
}

function captureOf(options: boolean | EventListenerOptions | undefined): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

function sameListener(a: ListenerRecord, b: ListenerRecord): boolean {
  return a.type === b.type && a.listener === b.listener && a.capture === b.capture;
}

/** A named `EventTarget` stand-in that logs each listener added and removed. */
export class RecordingTarget implements ListenerTarget {
  /** Every add, in order, including ones the DOM would ignore as duplicates. */
  readonly added: ListenerRecord[] = [];
  /** Every remove that matched a live listener, in order. */
  readonly removed: ListenerRecord[] = [];
  private live: ListenerRecord[] = [];

  constructor(readonly name = 'target') {}

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const record: ListenerRecord = {
      target: this.name,
      type,
      capture: captureOf(options),
      listener,
    };
    if (typeof options === 'object') {
      if (options.passive !== undefined) record.passive = options.passive;
      if (options.once !== undefined) record.once = options.once;
    }
    this.added.push(record);
    // The DOM adds a listener once per (type, listener, capture).
    if (!this.live.some((other) => sameListener(other, record))) this.live.push(record);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    const probe: ListenerRecord = {
      target: this.name,
      type,
      capture: captureOf(options),
      listener,
    };
    const index = this.live.findIndex((other) => sameListener(other, probe));
    if (index < 0) return;
    this.removed.push(this.live[index]);
    this.live.splice(index, 1);
  }

  /** The listeners still attached, in the order they were added. */
  get active(): readonly ListenerRecord[] {
    return this.live;
  }

  /** Calls the live listeners for `event.type` in order, as the DOM's target phase does. */
  dispatch(event: Event | { type: string }): void {
    for (const record of this.live.filter((r) => r.type === event.type)) {
      if (record.once) this.removeEventListener(record.type, record.listener, record.capture);
      const { listener } = record;
      if (typeof listener === 'function') listener(event as Event);
      else listener.handleEvent(event as Event);
    }
  }
}

/**
 * Records the listeners later added to and removed from a real DOM `target` (a happy-dom
 * element or document) while still adding them to it, so a feature test can read the
 * listener order and teardown of targets its code also queries, and dispatch real events.
 */
export function recordListeners(target: EventTarget, name: string): RecordingTarget {
  const recording = new RecordingTarget(name);
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, listener, options) => {
    if (listener) recording.addEventListener(type, listener, options);
    add(type, listener, options);
  };
  target.removeEventListener = (type, listener, options) => {
    if (listener) recording.removeEventListener(type, listener, options);
    remove(type, listener, options);
  };
  return recording;
}
