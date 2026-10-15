import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { installClipboard } from './clipboard-feature';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** The feature installed on fakes, with what reached the clipboard. */
function setup() {
  fake = fakeContext();
  const written: string[] = [];
  const feature = installClipboard(fake.ctx, {
    clipboard: {
      writeText: async (text) => {
        written.push(text);
      },
    },
  });
  /** Fires an OSC 52 write and lets the clipboard promise settle. */
  const osc52 = async (text: string) => {
    fake.term.fire('onClipboardWrite', text);
    await Promise.resolve();
  };
  return { feature, written, osc52 };
}

describe('installClipboard', () => {
  test('arms on window capture keydown, mousedown, paste and drop, and subscribes once', () => {
    setup();
    expect(fake.win.added.map(({ target, type, capture }) => ({ target, type, capture }))).toEqual(
      ['keydown', 'mousedown', 'paste', 'drop'].map((type) => ({
        target: 'window',
        type,
        capture: true,
      })),
    );
    expect(fake.term.subscriptions).toEqual(['onClipboardWrite']);
  });

  test.each(['keydown', 'mousedown', 'paste', 'drop'])(
    'writes only after input (%s) since the last connect (ADR 052)',
    async (type) => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      const { feature, written, osc52 } = setup();
      await osc52('before input');
      fake.win.dispatch({ type });
      await osc52('after input');
      feature.connected();
      await osc52('replayed');
      fake.win.dispatch({ type });
      await osc52('again');
      expect(written).toEqual(['after input', 'again']);
      warn.mockRestore();
    },
  );

  test('dispose removes everything it added; twice is a no-op', async () => {
    const { feature, written, osc52 } = setup();
    fake.win.dispatch({ type: 'keydown' });
    feature.dispose();
    feature.dispose();
    expect(fake.win.active).toEqual([]);
    expect(fake.win.removed.map((r) => r.type)).toEqual(['drop', 'paste', 'mousedown', 'keydown']);
    await osc52('after dispose');
    expect(written).toEqual([]);
  });
});
