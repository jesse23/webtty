import { afterEach, describe, expect, test } from 'bun:test';
import { createDomWindow, type DomWindow } from '../../../test-support/dom-window';
import { RecordingTarget } from '../../../test-support/recording-target';
import {
  DisposableStore,
  listen,
  toDisposable,
} from '../../ghostty-web/lifecycle/disposable-store';

describe('toDisposable', () => {
  test('runs its release once', () => {
    let runs = 0;
    const disposable = toDisposable(() => runs++);
    disposable.dispose();
    disposable.dispose();
    expect(runs).toBe(1);
  });
});

describe('DisposableStore', () => {
  test('disposes everything in reverse order of adding', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    for (const name of ['a', 'b', 'c']) store.add(toDisposable(() => order.push(name)));
    store.dispose();
    expect(order).toEqual(['c', 'b', 'a']);
  });

  test('a second dispose does nothing', () => {
    let runs = 0;
    const store = new DisposableStore();
    store.add(toDisposable(() => runs++));
    expect(store.isDisposed).toBe(false);
    store.dispose();
    store.dispose();
    expect(runs).toBe(1);
    expect(store.isDisposed).toBe(true);
  });

  test('add returns the item, and an item added after dispose is disposed at once', () => {
    const store = new DisposableStore();
    const kept = { dispose() {} };
    expect(store.add(kept)).toBe(kept);
    store.dispose();
    let late = 0;
    store.add(toDisposable(() => late++));
    expect(late).toBe(1);
  });

  test('a throwing item does not stop the rest; the first error is rethrown', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(toDisposable(() => order.push('first')));
    store.add({
      dispose() {
        throw new Error('older');
      },
    });
    store.add({
      dispose() {
        throw new Error('newest');
      },
    });
    expect(() => store.dispose()).toThrow('newest');
    expect(order).toEqual(['first']);
    expect(() => store.dispose()).not.toThrow();
  });
});

describe('listen', () => {
  const fn = () => {};

  test.each([
    ['no options', undefined, false],
    ['capture true', true, true],
    ['capture false', false, false],
    ['{ capture: true }', { capture: true }, true],
    ['{ passive: true }', { passive: true }, false],
  ] as const)('removes with the same capture flag: %s', (_name, options, capture) => {
    const target = new RecordingTarget('el');
    const disposable = listen(target, 'keydown', fn, options);
    expect(target.added).toEqual([
      expect.objectContaining({ type: 'keydown', capture, listener: fn }),
    ]);
    disposable.dispose();
    expect(target.active).toEqual([]);
    expect(target.removed).toEqual(target.added);
  });

  test('disposing twice removes once', () => {
    const target = new RecordingTarget();
    const disposable = listen(target, 'blur', fn, true);
    // A second listener with the other capture flag must survive both disposes.
    listen(target, 'blur', fn, false);
    disposable.dispose();
    disposable.dispose();
    expect(target.removed).toHaveLength(1);
    expect(target.active).toEqual([expect.objectContaining({ type: 'blur', capture: false })]);
  });

  describe('on a real DOM', () => {
    let dom: DomWindow;
    afterEach(() => dom.close());

    test('a capture listener stops hearing events once its store is disposed', () => {
      dom = createDomWindow();
      const button = dom.document.createElement('button');
      dom.document.body.appendChild(button);
      const heard: string[] = [];
      const store = new DisposableStore();
      store.add(listen(dom.document, 'click', () => heard.push('document'), { capture: true }));
      store.add(listen(button, 'click', () => heard.push('button')));
      button.click();
      expect(heard).toEqual(['document', 'button']);
      store.dispose();
      button.click();
      expect(heard).toEqual(['document', 'button']);
    });
  });
});
