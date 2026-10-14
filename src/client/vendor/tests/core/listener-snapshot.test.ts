import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ListenerRecord, RecordingTarget } from '../../../test-support/recording-target';
import { Terminal } from '../../ghostty-web/terminal';
import { FakeDocument, FakeElement, FakeWindow } from '../support/fake-event-target';
import { loadGhostty } from '../support/wasm';

// The baseline the vendor split (ADR 061) is held to: every listener Terminal.open() adds,
// in order, with its target, type and flags, and whether dispose() removes it (ADR 064).
// Each split step leaves this unchanged. Only the ADR 065 fix may change it: the rows
// marked LEAKS become removed and the empty compositionupdate listener goes.

/** One row: target, type, the flags set, and what dispose() did with it. */
function row(record: ListenerRecord, targets: readonly RecordingTarget[]): string {
  const flags = [
    record.capture ? 'capture' : '',
    record.once ? 'once' : '',
    record.passive === false ? 'passive:false' : '',
  ].filter(Boolean);
  const target = targets.find((t) => t.name === record.target);
  const removed = target?.removed.includes(record) ?? false;
  return [record.target, record.type, ...flags, removed ? '-> removed' : '-> LEAKS'].join(' ');
}

/** Today's listeners, in the order open() adds them. */
const SNAPSHOT = [
  'container beforeinput -> LEAKS',
  'container focusin -> removed',
  'window focus -> LEAKS',
  'container focusin -> removed',
  'container focusout -> removed',
  'window blur -> LEAKS',
  'document visibilitychange -> LEAKS',
  // The terminal's canvas: it focuses the textarea on a press or tap
  'canvas mousedown -> LEAKS',
  'canvas touchend -> LEAKS',
  // CanvasRenderer: the drawing canvas and the device-pixel-ratio watch
  'drawCanvas contextrestored -> removed',
  'mediaQuery change once -> removed',
  // InputHandler
  'container keydown -> removed',
  'textarea beforeinput -> removed',
  'container compositionstart -> removed',
  'container compositionupdate -> removed',
  'container compositionend -> removed',
  'container mousedown -> removed',
  'document mouseup -> removed',
  'document mousemove -> removed',
  // SelectionManager
  'canvas mousedown -> LEAKS',
  'canvas mousemove -> LEAKS',
  'canvas mouseleave -> LEAKS',
  'canvas mouseenter -> LEAKS',
  'document mousemove -> removed',
  'document mousedown -> LEAKS',
  'document mouseup -> removed',
  'canvas click -> LEAKS',
  'document click -> removed',
  // Terminal: links, scrollbar, the context menu, scrollbar drag and the wheel
  'container mousedown capture -> removed',
  'container mousemove -> removed',
  'container mouseleave -> removed',
  'container click -> removed',
  'container mousedown capture -> removed',
  'container keydown capture -> removed',
  'container contextmenu capture -> removed',
  'document mouseup -> LEAKS',
  'container wheel capture passive:false -> removed',
];

describe('Terminal listener snapshot', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'].map(
    (key) => [key, g[key]] as const,
  );
  let timeline: ListenerRecord[];
  let doc: FakeDocument;
  let win: FakeWindow;
  let container: FakeElement;

  beforeEach(() => {
    timeline = [];
    doc = new FakeDocument(timeline, {
      canvas: ['canvas', 'drawCanvas', 'scratchCanvas', 'measureCanvas'],
      textarea: ['textarea'],
    });
    win = new FakeWindow(timeline);
    container = new FakeElement('container', 'div', doc);
    // The vendored code reads these globals; no frame ever runs.
    g.document = doc;
    g.window = win;
    g.requestAnimationFrame = () => 1;
    g.cancelAnimationFrame = () => {};
  });

  afterEach(() => {
    for (const [key, value] of saved) g[key] = value;
  });

  /** Opens a terminal as webtty does: copy on select, a blinking cursor, OSC 52 and OSC 9 reports on. */
  async function openTerminal(): Promise<Terminal> {
    const term = new Terminal({
      ghostty: await loadGhostty(),
      cols: 80,
      rows: 24,
      cursorBlink: true,
      copyOnSelect: true,
      clipboardWrite: true,
      desktopNotifications: true,
    });
    term.open(container as unknown as HTMLElement);
    return term;
  }

  const targets = () => [container, doc, win, ...doc.created, ...win.mediaQueries];

  test('open() adds these listeners in this order, and dispose() removes the ones marked', async () => {
    const term = await openTerminal();
    const opened = timeline.length;
    term.dispose();
    // dispose() adds nothing
    expect(timeline.length).toBe(opened);
    expect(timeline.map((record) => row(record, targets()))).toEqual(SNAPSHOT);
    // The cursor blink, the one interval open() starts on the window
    expect(win.intervals).toEqual([530]);
  });

  test('a second dispose() removes nothing more', async () => {
    const term = await openTerminal();
    term.dispose();
    const removed = targets().map((target) => target.removed.length);
    term.dispose();
    expect(targets().map((target) => target.removed.length)).toEqual(removed);
  });

  test('the listeners left after dispose() are the leaking ones', async () => {
    const term = await openTerminal();
    term.dispose();
    const left = targets().flatMap((target) =>
      target.active.map((record) => row(record, targets())),
    );
    expect(left.sort()).toEqual(SNAPSHOT.filter((r) => r.endsWith('LEAKS')).sort());
  });
});
