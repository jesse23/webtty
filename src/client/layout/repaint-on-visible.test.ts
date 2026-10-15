import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../test-support/fake-context';
import { installRepaintOnVisible } from './repaint-on-visible';

let fake: FakeContext;
afterEach(() => fake.dom.close());

describe('installRepaintOnVisible', () => {
  test('a tab made visible again repaints every row at the current viewport', () => {
    fake = fakeContext();
    fake.term.attachRenderer();
    fake.term.viewportY = 3;
    installRepaintOnVisible(fake.ctx);
    fake.setVisibility('hidden');
    expect(fake.term.calls).toEqual([]);
    fake.setVisibility('visible');
    expect(fake.term.calls).toEqual(['render:all@3']);
  });

  test('before the terminal is open there is nothing to repaint', () => {
    fake = fakeContext();
    installRepaintOnVisible(fake.ctx);
    fake.setVisibility('visible');
    expect(fake.term.calls).toEqual([]);
  });

  test('dispose removes the listener; twice is a no-op', () => {
    fake = fakeContext();
    fake.term.attachRenderer();
    const feature = installRepaintOnVisible(fake.ctx);
    feature.dispose();
    feature.dispose();
    fake.setVisibility('visible');
    expect(fake.term.calls).toEqual([]);
  });
});
