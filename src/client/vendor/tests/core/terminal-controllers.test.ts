import { describe, expect, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import { type ListenerRecord, RecordingTarget } from '../../../test-support/recording-target';
import type { OpenedParts } from '../../ghostty-web/core/opened-parts';
import {
  type ControllersHost,
  TerminalControllers,
} from '../../ghostty-web/core/terminal-controllers';
import { TerminalEmitters } from '../../ghostty-web/core/terminal-emitters';

// Terminal's controllers as one unit: the order attach() adds their listeners in, what
// detach() takes away, and the input route. Each controller has its own tests; the
// wiring is exercised whole by vendor/tests/core/terminal.test.ts.

function controllers(options: { disableStdin?: boolean } = {}) {
  const log: string[] = [];
  const clock = new ManualClock();
  const term: ControllersHost = {
    options: {
      disableStdin: options.disableStdin ?? false,
      rightClickBehavior: 'contextMenu',
      mouseScrollSpeed: 1,
    },
    cols: 20,
    rows: 5,
    viewportY: 3,
    getScrollbackLength: () => 10,
    scrollToLine: (line) => void log.push(`scroll to ${line}`),
    scrollToBottom: () => void log.push('scroll to bottom'),
  };
  const emit = new TerminalEmitters();
  emit.data.event((data) => void log.push(`data ${JSON.stringify(data)}`));
  // The input route reaches the selection, the render loop the engine's replies
  const parts = {
    selection: { clearSelection: () => void log.push('clear selection') },
    engine: { hasResponse: () => false },
  };
  const core = new TerminalControllers(
    term,
    {
      emit,
      parts: () => parts as unknown as OpenedParts,
      live: () => true,
      beforeRender: () => {},
      setTitle: (title) => void log.push(`title ${title}`),
      render: (force, opacity) => void log.push(`render ${force} ${opacity}`),
      anchorTextarea: () => {},
      cellPixelSize: () => null,
    },
    clock,
  );
  return { core, log, emit, clock };
}

/** A container and a document logging into one timeline. */
function targets() {
  const timeline: ListenerRecord[] = [];
  const container = new RecordingTarget('container');
  const doc = new RecordingTarget('document');
  container.timeline = timeline;
  doc.timeline = timeline;
  const rows = () => timeline.map((r) => `${r.target} ${r.type}${r.capture ? ' capture' : ''}`);
  return { container, doc, rows };
}

describe('TerminalControllers attach and detach', () => {
  test('attach() adds the listeners in the order open() always has', () => {
    const { core } = controllers();
    const { container, doc, rows } = targets();
    core.attach(container as unknown as HTMLElement, doc);
    expect(rows()).toEqual([
      'container mousedown capture',
      'container mousemove',
      'container mouseleave',
      'container click',
      'container mousedown capture',
      'container keydown capture',
      'container contextmenu capture',
      'document mouseup',
      'container wheel capture',
    ]);
  });

  test("detach() removes every listener, the document's mouseup too; again does nothing (ADR 065)", () => {
    const { core } = controllers();
    const { container, doc } = targets();
    core.attach(container as unknown as HTMLElement, doc);
    core.detach();
    const removed = container.removed.length + doc.removed.length;
    core.detach();
    expect([container.active, doc.active]).toEqual([[], []]);
    expect(container.removed.length + doc.removed.length).toBe(removed);
  });
});

describe('TerminalControllers input', () => {
  // Keys and text clear the selection and scroll to the bottom; a mouse report leaves both,
  // so a Shift selection outlives the app's hover and clicks (ADR 051, ADR 055).
  test('a key clears the selection, scrolls to the bottom, then goes out', () => {
    const { core, log } = controllers();
    core.input('a');
    expect(log).toEqual(['clear selection', 'scroll to bottom', 'data "a"']);
  });

  test('a mouse report only goes out', () => {
    const { core, log } = controllers();
    core.input('\x1b[M !!', true);
    expect(log).toEqual(['data "\\u001b[M !!"']);
  });

  test('nothing goes out with stdin disabled', () => {
    const { core, log } = controllers({ disableStdin: true });
    core.input('a');
    expect(log).toEqual([]);
  });
});

describe('TerminalControllers wiring', () => {
  test('a view move fires onScroll and shows the scrollbar, rendering it', () => {
    const { core, log, emit } = controllers();
    emit.scroll.event((y) => void log.push(`onScroll ${y}`));
    core.viewport.scrollToLine(4);
    expect(log).toEqual(['onScroll 4', 'render false 0']);
  });

  test('the render loop runs frames on the injected clock until stopped', () => {
    const { core, log, clock } = controllers();
    core.renderLoop.start();
    clock.frame();
    core.renderLoop.cancel();
    clock.frame();
    expect(log).toEqual(['render false undefined', 'render false undefined']);
  });

  test('a mouse move goes to a scrollbar drag only while there is one', () => {
    const { core } = controllers();
    expect(core.scrollbar.drag({ clientY: 0 } as MouseEvent)).toBe(false);
  });
});
