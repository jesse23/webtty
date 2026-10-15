import { afterEach, describe, expect, test } from 'bun:test';
import { type FakeContext, fakeContext } from '../../test-support/fake-context';
import { recordListeners } from '../../test-support/recording-target';
import { installPaste } from './paste-feature';
import { PasteService } from './paste-service';

let fake: FakeContext;
afterEach(() => fake.dom.close());

/** The feature on a context whose container's listeners are recorded; the socket is open. */
function setup() {
  fake = fakeContext();
  const container = recordListeners(fake.container, 'container');
  const sent: string[] = [];
  let reads = 0;
  const paste = new PasteService(
    fake.term,
    { isOpen: () => true, send: (data) => sent.push(data) },
    {
      clipboard: {
        readText: async () => {
          reads++;
          return 'clip';
        },
      },
    },
  );
  const feature = installPaste(fake.ctx, { paste });
  // A later listener on the same node, which stopImmediatePropagation keeps from running
  let reachedLater = false;
  fake.container.addEventListener('paste', () => (reachedLater = true), true);
  /** Dispatches a real `paste` event holding `text` (null: no clipboard data). */
  const pasteEvent = (text: string | null) => {
    const { window } = fake.dom;
    let clipboardData: DataTransfer | null = null;
    if (text !== null) {
      clipboardData = new window.DataTransfer();
      clipboardData.setData('text/plain', text);
    }
    reachedLater = false;
    const event = new window.ClipboardEvent('paste', { clipboardData, cancelable: true });
    fake.container.dispatchEvent(event);
    return { prevented: event.defaultPrevented, stopped: !reachedLater };
  };
  return { container, sent, feature, pasteEvent, reads: () => reads };
}

describe('installPaste', () => {
  test('subscribes to onPasteRequest, then adds the container capture paste listener', () => {
    const { container } = setup();
    expect(fake.term.subscriptions).toEqual(['onPasteRequest']);
    expect(container.added.map(({ target, type, capture }) => ({ target, type, capture }))).toEqual(
      [
        { target: 'container', type: 'paste', capture: true },
        // the test's own later listener
        { target: 'container', type: 'paste', capture: true },
      ],
    );
    expect(fake.win.added).toEqual([]);
  });

  test('the right click set to paste reads the clipboard (ADR 051)', async () => {
    const { reads } = setup();
    fake.term.fire('onPasteRequest');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(1);
    expect(fake.term.calls).toEqual(['paste:clip']);
  });

  test('a paste event is consumed and its text goes through the terminal', () => {
    const { pasteEvent } = setup();
    expect(pasteEvent('hi')).toEqual({ prevented: true, stopped: true });
    expect(fake.term.calls).toEqual(['paste:hi']);
  });

  test('a paste event with no text sends Ctrl+V (ADR 037)', () => {
    const { pasteEvent, sent } = setup();
    pasteEvent('');
    expect(sent).toEqual(['\x16']);
    expect(fake.term.calls).toEqual(['scrollToBottom']);
  });

  test('a paste event without clipboard data is left alone', () => {
    const { pasteEvent } = setup();
    expect(pasteEvent(null)).toEqual({ prevented: false, stopped: false });
    expect(fake.term.calls).toEqual([]);
  });

  test('dispose removes the listener and the subscription; twice is a no-op', async () => {
    const { container, feature, reads, pasteEvent } = setup();
    feature.dispose();
    feature.dispose();
    expect(container.active).toHaveLength(1);
    expect(container.removed).toHaveLength(1);
    expect(pasteEvent('after')).toEqual({ prevented: false, stopped: false });
    fake.term.fire('onPasteRequest');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(0);
  });
});
