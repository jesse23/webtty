import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { type RecordingTarget, recordListeners } from '../../test-support/recording-target';
import { TabTitle } from './tab-title';
import { installTabTitle } from './tab-title-feature';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** The feature installed on fakes, with the titles it set and the container's listener log. */
function setup() {
  fake = fakeContext();
  const container: RecordingTarget = recordListeners(fake.container, 'container');
  const replay = { active: false };
  const titles: string[] = [];
  const tabTitle = new TabTitle('main', true, replay, (title) => titles.push(title));
  const feature = installTabTitle(fake.ctx, { tabTitle });
  const last = () => titles[titles.length - 1];
  return { feature, container, replay, last };
}

const focusin = () => fake.container.dispatchEvent(new fake.dom.window.FocusEvent('focusin'));

describe('installTabTitle', () => {
  test('adds container focusin, then window capture keydown, and subscribes title then bell', () => {
    const { container } = setup();
    const rows = (target: RecordingTarget) =>
      target.added.map(({ target, type, capture }) => ({ target, type, capture }));
    expect(rows(container)).toEqual([{ target: 'container', type: 'focusin', capture: false }]);
    expect(rows(fake.win)).toEqual([{ target: 'window', type: 'keydown', capture: true }]);
    expect(fake.term.subscriptions).toEqual(['onTitleChange', 'onBell']);
  });

  test("shows the program's title and marks a bell until focus or a key", () => {
    const { last } = setup();
    fake.term.fire('onTitleChange', 'vim');
    expect(last()).toBe('vim | webtty');
    fake.term.fire('onBell');
    expect(last()).toBe('🔔 vim | webtty');
    focusin();
    expect(last()).toBe('vim | webtty');
    fake.term.fire('onBell');
    fake.win.dispatch({ type: 'keydown' });
    expect(last()).toBe('vim | webtty');
  });

  test('a bell in the replay is ignored (ADR 053)', () => {
    const { replay, last } = setup();
    replay.active = true;
    fake.term.fire('onBell');
    expect(last()).toBe('main | webtty');
  });

  test('dispose removes everything it added; twice is a no-op', () => {
    const { feature, container, last } = setup();
    feature.dispose();
    feature.dispose();
    expect(container.active).toEqual([]);
    expect(fake.win.active).toEqual([]);
    expect(container.removed).toHaveLength(1);
    expect(fake.win.removed).toHaveLength(1);
    fake.term.fire('onTitleChange', 'vim');
    fake.term.fire('onBell');
    expect(last()).toBe('main | webtty');
  });
});
