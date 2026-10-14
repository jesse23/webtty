// webtty (ADR 060, ADR 065), not from upstream.
// The one teardown primitive (object): a DisposableStore collects what a class added,
// listeners, timers, animation frames, emitter subscriptions, and releases it once, in
// reverse order; listen() adds a DOM listener and returns the Disposable that removes it.

/**
 * Anything that releases what it holds. The same shape as xterm's `IDisposable`, so an
 * emitter subscription goes into a store as it is.
 */
export interface Disposable {
  dispose(): void;
}

/** The slice of `EventTarget` that `listen` needs, so a test can pass a recording fake. */
export interface ListenerTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** A `Disposable` that runs `release` the first time it is disposed, and never again. */
export function toDisposable(release: () => void): Disposable {
  let released = false;
  return {
    dispose() {
      if (released) return;
      released = true;
      release();
    },
  };
}

/**
 * Collects disposables and disposes them once, newest first, so teardown undoes setup in
 * the opposite order. Disposing twice does nothing, and anything added after the store
 * is disposed is disposed at once rather than leaked.
 */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  /** True once `dispose()` has run. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Takes ownership of `item` and returns it, so a store can wrap the expression that made it. */
  add<T extends Disposable>(item: T): T {
    if (this.disposed) item.dispose();
    else this.items.push(item);
    return item;
  }

  /** Disposes everything added, newest first. A throwing item does not stop the others; the first error is rethrown at the end. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const items = this.items;
    this.items = [];
    let failure: { error: unknown } | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        items[i].dispose();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  }
}

/** Whether `options` asks for the capture phase, which is what removal must match. */
function captureOf(options: boolean | AddEventListenerOptions | undefined): boolean {
  return typeof options === 'boolean' ? options : options?.capture === true;
}

/**
 * Adds `listener` for `type` on `target` and returns the `Disposable` that removes it with
 * the same capture flag (a listener added in the capture phase is only removed by a
 * matching `capture`). Overloads type the event for windows, documents and elements.
 */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function listen(
  target: ListenerTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): Disposable;
export function listen(
  target: ListenerTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): Disposable {
  target.addEventListener(type, listener, options);
  const capture = captureOf(options);
  return toDisposable(() => target.removeEventListener(type, listener, capture));
}
