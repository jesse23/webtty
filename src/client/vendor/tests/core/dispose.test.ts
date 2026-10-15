import { afterEach, describe, expect, test } from 'bun:test';
import type { RecordingTarget } from '../../../test-support/recording-target';
import { Terminal } from '../../ghostty-web/terminal';
import { fire } from '../support/selection-fixture';
import {
  openTerminal,
  type StubbedGlobals,
  stubGlobals,
  type TerminalHarness,
} from '../support/terminal-harness';
import { loadGhostty } from '../support/wasm';

// A disposed terminal leaves nothing behind (ADR 065): every listener added to the
// container, the canvases, the textarea, the document, the window and the media queries is
// removed with the options it was added with, every timeout, interval and animation frame
// is cancelled, and a second dispose() does nothing. The terminal is opened on the
// harness's fakes, so the spies are the recording targets and the manual clock.

let h: TerminalHarness | undefined;
let globals: StubbedGlobals | undefined;

afterEach(() => {
  h?.close();
  h = undefined;
  globals?.restore();
  globals = undefined;
});

/** Every recording target the terminal can have listened on. */
function targetsOf(container: RecordingTarget, g: Pick<TerminalHarness, 'doc' | 'win'>) {
  return [container, g.doc, g.win, ...g.doc.created, ...g.win.mediaQueries];
}

/** What is still attached or scheduled: listeners per target, the clock's and the window's timers. */
function leftover(targets: RecordingTarget[], g: Pick<TerminalHarness, 'clock' | 'win'>) {
  return {
    listeners: targets.flatMap((target) => target.active.map((r) => `${r.target} ${r.type}`)),
    ...g.clock.pending,
    windowTimers: g.win.timers.size,
  };
}

const NOTHING = { listeners: [], timers: 0, frames: 0, windowTimers: 0 };

describe('Terminal.dispose()', () => {
  test('every listener added is removed with the same capture flag', async () => {
    h = await openTerminal({ cursorBlink: true, copyOnSelect: true });
    const targets = targetsOf(h.container, h);
    h.term.dispose();
    for (const target of targets) {
      expect(target.active).toEqual([]);
      // Each add has its own remove: the record removed is the one added, flags and all
      expect(new Set(target.removed)).toEqual(new Set(target.added));
    }
  });

  test('timers and frames still waiting are cancelled', async () => {
    h = await openTerminal({ cursorBlink: true });
    const { term, clock, container } = h;
    // Scrollback, then a scroll into it: the scrollbar fades in and waits to hide
    term.write('\r\n'.repeat(20));
    term.scrollLines(-2);
    // A write callback waits for the next frame, the refocus for a timeout, a mouse move
    // for the hover throttle
    let called = false;
    term.write('x', () => {
      called = true;
    });
    term.focus();
    fire(container, 'mousemove', { clientX: 10, clientY: 10 });
    expect(clock.pending.timers).toBeGreaterThanOrEqual(3);
    expect(clock.pending.frames).toBeGreaterThanOrEqual(3);
    expect(h.win.timers.size).toBe(1);
    term.dispose();
    expect(leftover(targetsOf(container, h), h)).toEqual(NOTHING);
    clock.frame();
    expect(called).toBe(false);
  });

  test('a second dispose() removes and cancels nothing more', async () => {
    h = await openTerminal();
    const targets = targetsOf(h.container, h);
    h.term.dispose();
    const removed = targets.map((target) => target.removed.length);
    h.term.dispose();
    expect(targets.map((target) => target.removed.length)).toEqual(removed);
  });

  test('an open() that fails part way leaves nothing behind', async () => {
    const ghostty = await loadGhostty();
    globals = stubGlobals();
    const container = globals.element();
    // The InputHandler is made after the DOM, focus and renderer listeners
    const failing = Object.create(ghostty, {
      createKeyEncoder: {
        value: () => {
          throw new Error('no encoder');
        },
      },
    });
    const term = new Terminal({ ghostty: failing, cols: 20, rows: 5, cursorBlink: true });
    expect(() => term.open(container as unknown as HTMLElement)).toThrow('no encoder');
    const targets = targetsOf(container, globals);
    expect(targets.some((target) => target.added.length > 0)).toBe(true);
    expect(globals.win.intervals).toEqual([530]);
    expect(leftover(targets, globals)).toEqual(NOTHING);
  });
});
