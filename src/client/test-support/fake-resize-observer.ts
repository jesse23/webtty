// A ResizeObserver stand-in (test fake, ADR 064): it records what is observed and lets the
// test report a resize. fakeResizeObserver() gives a constructor to inject and its observers.

/** One observer: its callback, what it watches, and whether it was disconnected. */
export class FakeResizeObserver {
  readonly observed: { target: Element; options?: ResizeObserverOptions }[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element, options?: ResizeObserverOptions): void {
    this.observed.push({ target, options });
  }

  unobserve(target: Element): void {
    const index = this.observed.findIndex((entry) => entry.target === target);
    if (index >= 0) this.observed.splice(index, 1);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.length = 0;
  }

  /** Reports a resize of everything observed, as the browser does after layout. */
  resize(): void {
    if (this.disconnected) return;
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** A `ResizeObserver` constructor to inject, and the observers it made, in order. */
export interface FakeResizeObserverClass {
  ResizeObserver: typeof ResizeObserver;
  observers: FakeResizeObserver[];
}

/** Makes a fresh `ResizeObserver` stand-in whose observers the test can reach. */
export function fakeResizeObserver(): FakeResizeObserverClass {
  const observers: FakeResizeObserver[] = [];
  class RecordedObserver extends FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.push(this);
    }
  }
  // The fake covers the members the client uses.
  return { ResizeObserver: RecordedObserver as unknown as typeof ResizeObserver, observers };
}
