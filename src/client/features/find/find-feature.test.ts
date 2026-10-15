import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { ManualClock } from '../../test-support/manual-clock';
import { FIND_DELAY_MS } from './find-bar';
import { installFind } from './find-feature';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** The find feature on fakes, its search delay on a manual clock. */
function setup() {
  fake = fakeContext();
  const clock = new ManualClock();
  const looked: string[] = [];
  const feature = installFind(fake.ctx, {
    shortcutActionOf: (e) => {
      looked.push(e.code);
      return e.code === 'Escape' ? 'findClose' : undefined;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const doc = fake.ctx.doc;
  const bar = () => doc.querySelector('.find-bar') as HTMLElement | null;
  const input = () => doc.getElementById('find-bar-input') as HTMLInputElement;
  return { feature, clock, looked, bar, input };
}

describe('installFind', () => {
  test('appends the bar to the body and subscribes once to onFindChange', () => {
    const { bar } = setup();
    expect(bar()?.parentElement).toBe(fake.ctx.doc.body);
    expect(fake.term.subscriptions).toEqual(['onFindChange']);
    expect(fake.win.added).toEqual([]);
  });

  test('opens, searches after the delay and moves through the terminal', () => {
    const { feature, clock, bar, input } = setup();
    expect(feature.isOpen).toBe(false);
    feature.open();
    expect(feature.isOpen).toBe(true);
    expect(bar()?.hidden).toBe(false);
    input().value = 'needle';
    input().dispatchEvent(new fake.dom.window.Event('input'));
    clock.advance(FIND_DELAY_MS);
    feature.go('next');
    feature.go('previous');
    expect(fake.term.calls).toEqual(['find:needle', 'findNext', 'findPrevious']);
  });

  test('closing ends the search and refocuses the terminal', () => {
    const { feature } = setup();
    feature.open();
    feature.close();
    expect(feature.isOpen).toBe(false);
    expect(fake.term.calls).toEqual(['endFind', 'focus']);
  });

  test('the field reads the find keys through the lookup it was given', () => {
    const { feature, looked, input } = setup();
    feature.open();
    input().dispatchEvent(new fake.dom.window.KeyboardEvent('keydown', { code: 'Escape' }));
    expect(looked).toEqual(['Escape']);
    expect(feature.isOpen).toBe(false);
  });

  test('shows the terminal’s match count', () => {
    const { bar } = setup();
    fake.term.fire('onFindChange', { total: 5, selected: 1 });
    expect(bar()?.querySelector('.find-bar-count')?.textContent).toBe('2/5');
  });

  test('dispose removes the bar and the subscription; twice is a no-op', () => {
    const { feature, bar } = setup();
    feature.dispose();
    feature.dispose();
    expect(bar()).toBeNull();
    fake.term.fire('onFindChange', { total: 1, selected: 0 });
  });
});
