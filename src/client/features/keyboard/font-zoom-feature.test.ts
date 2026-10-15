import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { installFontZoom } from './font-zoom-feature';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** Font zoom on a fake window, with its fits counted. */
function setup(fontSize = 14) {
  fake = fakeContext({ fontSize });
  let fits = 0;
  const feature = installFontZoom(fake.ctx, { fit: () => fits++ });
  /** Dispatches a keydown of `code` with Ctrl held; returns the event calls it made. */
  const press = (code: string, mods: Partial<KeyboardEventInit> = {}) => {
    const calls: string[] = [];
    const event = {
      type: 'keydown',
      code,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      ...mods,
      preventDefault: () => calls.push('preventDefault'),
      stopPropagation: () => calls.push('stopPropagation'),
    };
    fake.win.dispatch(event);
    return calls;
  };
  return { feature, press, fits: () => fits, size: () => fake.term.options.fontSize };
}

describe('installFontZoom', () => {
  test('adds one window capture keydown listener', () => {
    setup();
    expect(fake.win.added.map(({ target, type, capture }) => ({ target, type, capture }))).toEqual([
      { target: 'window', type: 'keydown', capture: true },
    ]);
    expect(fake.term.subscriptions).toEqual([]);
  });

  test('zooms in, out and back, fitting at once, and consumes the key (ADR 033)', () => {
    const { press, fits, size } = setup();
    expect(press('Equal')).toEqual(['preventDefault', 'stopPropagation']);
    expect(size()).toBe(15);
    press('NumpadAdd', { ctrlKey: false, metaKey: true });
    expect(size()).toBe(16);
    press('Minus');
    press('Minus');
    press('Minus');
    expect(size()).toBe(13);
    press('Digit0');
    expect(size()).toBe(14);
    expect(fits()).toBe(6);
  });

  test('other keys are left alone', () => {
    const { press, fits, size } = setup();
    expect(press('KeyA')).toEqual([]);
    expect(press('Equal', { ctrlKey: false })).toEqual([]);
    expect(size()).toBeUndefined();
    expect(fits()).toBe(0);
  });

  test('a configured size out of range starts clamped, so the first step goes the right way', () => {
    const { press, size } = setup(40);
    press('Minus');
    expect(size()).toBe(31);
    press('Digit0');
    expect(size()).toBe(32);
  });

  test('dispose removes the listener; twice is a no-op', () => {
    const { feature, press, fits } = setup();
    feature.dispose();
    feature.dispose();
    expect(fake.win.active).toEqual([]);
    expect(fake.win.removed).toHaveLength(1);
    press('Equal');
    expect(fits()).toBe(0);
  });
});
