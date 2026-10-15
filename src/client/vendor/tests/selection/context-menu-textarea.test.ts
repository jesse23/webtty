import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import { RecordingTarget } from '../../../test-support/recording-target';
import {
  browserMenuTimers,
  CONTEXT_MENU_RESET_DELAY_MS,
  ContextMenuTextarea,
} from '../../ghostty-web/selection/context-menu-textarea';
import { FakeTextarea, fire } from '../support/selection-fixture';

// The textarea a right-click menu opens on: shown at the pointer with the selection, and
// hidden again by the first click, contextmenu or blur after the menu opens.

function menu() {
  const textarea = new FakeTextarea();
  const doc = new RecordingTarget('document');
  const clock = new ManualClock();
  const shown = new ContextMenuTextarea(textarea.element, doc as unknown as Document, clock);
  return { textarea, doc, clock, menu: shown };
}

const HIDDEN = {
  position: 'fixed',
  pointerEvents: 'none',
  zIndex: '-10',
  width: '0',
  height: '0',
  left: '0',
  top: '0',
  opacity: '0',
};

describe('ContextMenuTextarea', () => {
  test('shows the textarea at the pointer holding the selected text, focused', () => {
    const { textarea, menu: m } = menu();
    m.show({ clientX: 12, clientY: 34 }, 'picked');
    expect(textarea.style).toEqual({
      position: 'fixed',
      left: '12px',
      top: '34px',
      width: '1px',
      height: '1px',
      zIndex: '1000',
      opacity: '0',
      pointerEvents: 'auto',
    });
    expect(textarea.value).toBe('picked');
    expect(textarea.calls).toEqual(['select', 'range 0-6', 'focus']);
  });

  test('with nothing selected, the textarea is empty and the menu still opens on it', () => {
    const { textarea, menu: m } = menu();
    textarea.value = 'stale';
    m.show({ clientX: 0, clientY: 0 }, null);
    expect(textarea.value).toBe('');
    expect(textarea.calls).toEqual(['focus']);
  });

  test.each(['click', 'contextmenu', 'blur'])(
    'a %s after the delay hides the textarea and drops the other listeners',
    (type) => {
      const { textarea, doc, clock, menu: m } = menu();
      m.show({ clientX: 12, clientY: 34 }, 'picked');
      // Nothing listens until the menu has had time to open
      clock.advance(CONTEXT_MENU_RESET_DELAY_MS - 1);
      expect(doc.active).toHaveLength(0);
      clock.advance(1);
      expect(doc.active.map((r) => [r.type, r.once])).toEqual([
        ['click', true],
        ['contextmenu', true],
      ]);
      expect(textarea.active.map((r) => r.type)).toEqual(['blur']);
      fire(type === 'blur' ? textarea : doc, type);
      expect(textarea.style).toEqual(HIDDEN);
      expect(textarea.value).toBe('');
      expect(doc.active).toHaveLength(0);
      expect(textarea.active).toHaveLength(0);
    },
  );

  test('dispose() cancels the wait, then the close listeners; again does nothing (ADR 065)', () => {
    const { textarea, doc, clock, menu: m } = menu();
    m.show({ clientX: 1, clientY: 1 }, null);
    m.dispose();
    clock.advance(CONTEXT_MENU_RESET_DELAY_MS);
    expect([doc.added.length, clock.pending.timers]).toEqual([0, 0]);
    // Two menus open, both listening for the close
    m.show({ clientX: 1, clientY: 1 }, null);
    m.show({ clientX: 2, clientY: 2 }, null);
    clock.advance(CONTEXT_MENU_RESET_DELAY_MS);
    expect(doc.active).toHaveLength(4);
    m.dispose();
    m.dispose();
    for (const target of [doc, textarea]) {
      expect(target.active).toEqual([]);
      expect(target.removed).toEqual(target.added);
    }
  });

  test('a menu that closed is forgotten: dispose() removes nothing more', () => {
    const { textarea, doc, clock, menu: m } = menu();
    m.show({ clientX: 1, clientY: 1 }, null);
    clock.advance(CONTEXT_MENU_RESET_DELAY_MS);
    fire(doc, 'click');
    const removed = doc.removed.length + textarea.removed.length;
    m.dispose();
    expect(doc.removed.length + textarea.removed.length).toBe(removed);
  });

  test('the browser timers are the global setTimeout and clearTimeout', async () => {
    let ran = false;
    browserMenuTimers.clearTimeout(browserMenuTimers.setTimeout(() => (ran = true), 0));
    await Bun.sleep(5);
    expect(ran).toBe(false);
  });

  test('waits on the global setTimeout by default', async () => {
    const textarea = new FakeTextarea();
    const doc = new RecordingTarget('document');
    new ContextMenuTextarea(textarea.element, doc as unknown as Document).show(
      { clientX: 1, clientY: 1 },
      null,
    );
    await Bun.sleep(CONTEXT_MENU_RESET_DELAY_MS + 10);
    expect(doc.active).toHaveLength(2);
  });
});
