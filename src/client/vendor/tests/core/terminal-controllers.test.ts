import { describe, expect, spyOn, test } from 'bun:test';
import { ManualClock } from '../../../test-support/manual-clock';
import { type ListenerRecord, RecordingTarget } from '../../../test-support/recording-target';
import type { OpenedParts } from '../../ghostty-web/core/opened-parts';
import {
  type ControllersHost,
  type ControllersInternalsHost,
  findHost,
  focusHost,
  mouseHost,
  renderLoopHost,
  scrollbarHost,
  syncHoldHost,
  TerminalControllers,
  wheelHost,
  writeHost,
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
  // The input route reaches the selection, the render loop the engine's replies and modes
  const parts = {
    selection: { clearSelection: () => void log.push('clear selection') },
    engine: { hasResponse: () => false, getMode: () => false },
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

/**
 * A terminal, its internals and its parts that log every call they get, and real
 * controllers over them whose cross-calls log too, for the host builders' tests.
 */
function world() {
  const log: string[] = [];
  /** Whether the engine reports the app's synchronized update (mode 2026) on. */
  const sync = { on: false };
  const parts = {
    element: { id: 'element' },
    textarea: { id: 'textarea' },
    canvas: { id: 'canvas' },
    engine: {
      hasResponse: () => true,
      getMode: (mode: number) => mode === 2026 && sync.on,
      setMode: (mode: number, on: boolean) => void log.push(`mode ${mode} ${on}`),
    },
    renderer: {
      scrollOffset: 7,
      setSearchHighlights: () => void log.push('highlight'),
      getMetrics: () => ({ width: 8, height: 16 }),
    },
    links: { invalidateCache: () => void log.push('links stale') },
    selection: { id: 'selection' },
  };
  const term: ControllersHost = {
    options: { disableStdin: true, rightClickBehavior: 'paste', mouseScrollSpeed: 3 },
    cols: 20,
    rows: 5,
    viewportY: 2,
    getScrollbackLength: () => 10,
    scrollToLine: (line) => void log.push(`scroll to ${line}`),
    scrollToBottom: () => void log.push('scroll to bottom'),
  };
  const emit = new TerminalEmitters();
  emit.data.event((data) => void log.push(`data ${data}`));
  emit.bell.event(() => void log.push('bell'));
  emit.clipboardWrite.event((text) => void log.push(`clipboard ${text}`));
  emit.desktopNotification.event((n) => void log.push(`notify ${n.title}`));
  emit.findChange.event((state) => void log.push(`find ${state.total}`));
  emit.pasteRequest.event(() => void log.push('paste request'));
  emit.updatePainted.event(() => void log.push('update painted'));
  const inner: ControllersInternalsHost = {
    emit,
    parts: () => parts as unknown as OpenedParts,
    live: () => true,
    beforeRender: (now) => void log.push(`before render ${now}`),
    setTitle: (title) => void log.push(`title ${title}`),
    render: (force, opacity) => void log.push(`render ${force} ${opacity}`),
    anchorTextarea: () => void log.push('anchor'),
    cellPixelSize: () => ({ width: 16, height: 32 }),
  };
  const core = new TerminalControllers(term, inner, new ManualClock());
  spyOn(core.focus, 'followMode').mockImplementation(() => void log.push('follow focus mode'));
  spyOn(core.finder, 'step').mockImplementation((now) => void log.push(`find step ${now}`));
  spyOn(core.writes, 'drainReplies').mockImplementation(() => void log.push('drain'));
  spyOn(core.viewport, 'pin').mockImplementation((e) => {
    log.push(`pin ${(e as unknown) === parts.engine}`);
    return true;
  });
  spyOn(core.viewport, 'unpin').mockImplementation(
    (e) => void log.push(`unpin ${(e as unknown) === parts.engine}`),
  );
  spyOn(core.sync, 'wrote').mockImplementation((data) => void log.push(`wrote ${data}`));
  spyOn(core.scrollbar, 'drag').mockImplementation(() => true);
  spyOn(core.mouse, 'encode').mockImplementation(() => 'report');
  return { log, parts, term, inner, core, sync };
}

// Each host member is one forwarding call to the terminal, its parts, its emitters or
// another controller; these pin where each one goes.
describe('TerminalControllers hosts', () => {
  test('focus: the parts, the stdin option and onData', () => {
    const { log, parts, term, inner } = world();
    const host = focusHost(term, inner);
    expect<unknown[]>([
      host.element(),
      host.textarea(),
      host.engine(),
      host.disableStdin(),
    ]).toEqual([parts.element, parts.textarea, parts.engine, true]);
    host.send('x');
    expect(log).toEqual(['data x']);
  });

  test('find: the engine, the renderer, the view and onFindChange', () => {
    const { log, parts, term, inner } = world();
    const host = findHost(term, inner);
    expect<unknown[]>([
      host.engine(),
      host.getScrollbackLength(),
      host.viewportY(),
      host.rows(),
    ]).toEqual([parts.engine, 10, 2, 5]);
    host.highlight({ matches: new Int32Array(0), selected: null });
    host.scrollToLine(4);
    host.changed({ total: 3, selected: 1 });
    expect(log).toEqual(['highlight', 'scroll to 4', 'find 3']);
  });

  test('write: the engine, the emitters, the link cache, the view and the controllers', () => {
    const { log, parts, term, inner, core, sync } = world();
    const host = writeHost(term, inner, core);
    expect<unknown[]>([host.engine(), host.disableStdin(), host.findAnchored()]).toEqual([
      parts.engine,
      true,
      core.finder.anchored,
    ]);
    host.send('r');
    host.followFocusMode();
    host.bell();
    host.title('t');
    host.clipboardWrite('c');
    host.notify({ title: 'n', body: '' });
    host.outputChanged();
    host.scrollToBottom();
    expect(host.pinView()).toBe(true);
    host.unpinView();
    host.wroteOutput('o');
    host.renderEcho();
    // An update's end paints only after a held frame, and tells the embedder (ADR 067)
    expect(host.syncPaintPoint('\x1b[?2026l')).toBe(-1);
    core.sync.frameHeld();
    expect(host.syncPaintPoint('\x1b[?2026l')).toBe(8);
    host.paintUpdate();
    expect(host.syncPaintPoint('\x1b[?2026l')).toBe(-1);
    // Inside the app's synchronized update the echo waits for the frame after it, and an
    // update's end does not paint while the engine still has the mode on
    sync.on = true;
    host.renderEcho();
    host.paintUpdate();
    expect(log).toEqual([
      'data r',
      'follow focus mode',
      'bell',
      'title t',
      'clipboard c',
      'notify n',
      'links stale',
      'scroll to bottom',
      'pin true',
      'unpin true',
      'wrote o',
      'render false undefined',
      'render false undefined',
      'update painted',
    ]);
  });

  test("sync hold: the engine's mode 2026, read and turned off", () => {
    const { log, inner, sync } = world();
    const host = syncHoldHost(inner);
    expect(host.active()).toBe(false);
    sync.on = true;
    expect(host.active()).toBe(true);
    host.end();
    expect(log).toEqual(['mode 2026 false']);
  });

  test("render loop: each of a frame's steps", () => {
    const { log, inner, core, sync } = world();
    const host = renderLoopHost(inner, core);
    expect<unknown[]>([host.live(), host.hasReplies(), host.renderHeld(0)]).toEqual([
      true,
      true,
      false,
    ]);
    sync.on = true;
    expect(host.renderHeld(1)).toBe(true);
    // A held frame makes the next update's end paint (ADR 067)
    expect(core.sync.paintPoint('\x1b[?2026l')).toBe(8);
    sync.on = false;
    host.beforeRender(1);
    host.stepFind(2);
    host.render();
    host.drainReplies();
    host.anchorTextarea();
    expect(log).toEqual([
      'before render 1',
      'find step 2',
      'render false undefined',
      'drain',
      'anchor',
    ]);
  });

  test('scrollbar: the canvas, the offset, the view and the render', () => {
    const { log, parts, term, inner } = world();
    const host = scrollbarHost(term, inner);
    expect<unknown[]>([
      host.canvas(),
      host.scrollOffset(),
      host.getScrollbackLength(),
      host.rows(),
      host.viewportY(),
    ]).toEqual([parts.canvas, 7, 10, 5, 2]);
    host.scrollToLine(1);
    host.render(0.5);
    expect(log).toEqual(['scroll to 1', 'render false 0.5']);
  });

  test('mouse: the parts, the grid, the cell, the option, the drag and onPasteRequest', () => {
    const { log, parts, term, inner, core } = world();
    const host = mouseHost(term, inner, core);
    expect<unknown[]>([
      host.element(),
      host.canvas(),
      host.engine(),
      host.renderer(),
      host.links(),
      host.selection(),
      host.rows(),
      host.cols(),
      host.viewportY(),
      host.cellPixelSize(),
      host.rightClickBehavior(),
      host.dragScrollbar({} as MouseEvent),
    ]).toEqual([
      parts.element,
      parts.canvas,
      parts.engine,
      parts.renderer,
      parts.links,
      parts.selection,
      5,
      20,
      2,
      { width: 16, height: 32 },
      'paste',
      true,
    ]);
    host.requestPaste();
    expect(log).toEqual(['paste request']);
  });

  test('wheel: the engine, the cell height, the grid, the option, the encoder and onData', () => {
    const { log, parts, term, inner, core } = world();
    const host = wheelHost(term, inner, core);
    expect<unknown[]>([
      host.engine(),
      host.cellHeight(),
      host.hasCanvas(),
      host.rows(),
      host.mouseScrollSpeed(),
      host.encodeMouse({
        clientX: 0,
        clientY: 0,
        button: null,
        action: 'motion',
        mods: 0,
        anyButtonPressed: false,
      }),
    ]).toEqual([parts.engine, 16, true, 5, 3, 'report']);
    host.send('w');
    expect(log).toEqual(['data w']);
  });
});
