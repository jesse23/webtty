import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ListenerRecord, RecordingTarget } from '../../../test-support/recording-target';
import { Terminal } from '../../ghostty-web/terminal';
import { FakeDocument, FakeElement, FakeWindow } from '../support/fake-event-target';
import { loadGhostty } from '../support/wasm';

// The baseline the vendor split (ADR 061) is held to: every listener Terminal.open() adds,
// in order, with its target, type and flags, and whether dispose() removes it (ADR 064).
// Since ADR 065 every row is removed, and upstream's empty compositionupdate listener is
// gone; a split step leaves this unchanged.

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

/** The listeners, in the order open() adds them; dispose() removes every one (ADR 065). */
const SNAPSHOT = [
  'container beforeinput -> removed',
  'container focusin -> removed',
  'window focus -> removed',
  'container focusin -> removed',
  'container focusout -> removed',
  'window blur -> removed',
  'document visibilitychange -> removed',
  // The terminal's canvas: it focuses the textarea on a press or tap
  'canvas mousedown -> removed',
  'canvas touchend -> removed',
  // CanvasRenderer: the drawing canvas and the device-pixel-ratio watch
  'drawCanvas contextrestored -> removed',
  'mediaQuery change once -> removed',
  // InputHandler
  'container keydown -> removed',
  'textarea beforeinput -> removed',
  'container compositionstart -> removed',
  'container compositionend -> removed',
  'container mousedown -> removed',
  'document mouseup -> removed',
  'document mousemove -> removed',
  // SelectionManager
  'canvas mousedown -> removed',
  'canvas mousemove -> removed',
  'canvas mouseleave -> removed',
  'canvas mouseenter -> removed',
  'document mousemove -> removed',
  'document mousedown -> removed',
  'document mouseup -> removed',
  'canvas click -> removed',
  'document click -> removed',
  // Terminal: links, scrollbar, the context menu, scrollbar drag and the wheel
  'container mousedown capture -> removed',
  'container mousemove -> removed',
  'container mouseleave -> removed',
  'container click -> removed',
  'container mousedown capture -> removed',
  'container keydown capture -> removed',
  'container contextmenu capture -> removed',
  'document mouseup -> removed',
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
  // The animation frames requested and not cancelled; none ever runs
  let frames: Set<number>;

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
    frames = new Set();
    let nextFrame = 1;
    g.requestAnimationFrame = () => {
      frames.add(nextFrame);
      return nextFrame++;
    };
    g.cancelAnimationFrame = (id: number) => frames.delete(id);
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
    // The cursor blink, the one interval open() starts on the window, and the refocus
    // after the DOM settles, the one timeout
    expect([win.intervals, win.timeouts]).toEqual([[530], [0]]);
  });

  test('dispose() clears every timeout and interval and cancels every frame (ADR 065)', async () => {
    const term = await openTerminal();
    expect([win.timers.size, frames.size]).toEqual([2, 1]);
    term.dispose();
    expect([win.timers.size, frames.size]).toEqual([0, 0]);
  });

  test('a second dispose() removes nothing more', async () => {
    const term = await openTerminal();
    term.dispose();
    const removed = targets().map((target) => target.removed.length);
    term.dispose();
    expect(targets().map((target) => target.removed.length)).toEqual(removed);
  });

  test('no listener is left after dispose(), and each went with its capture flag', async () => {
    const term = await openTerminal();
    term.dispose();
    for (const target of targets()) {
      expect(target.active).toEqual([]);
      expect(new Set(target.removed)).toEqual(new Set(target.added));
    }
  });
});
