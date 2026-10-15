// A whole vendored Terminal opened on fakes (test support, ADR 064): the fake document,
// window and container of the listener snapshot, the real wasm engine and a manual clock
// for frames and timeouts, so a test drives the terminal through its public API only. The
// vendored code reads globals; they are swapped in by openTerminal and put back by close().

import { ManualClock } from '../../../test-support/manual-clock';
import type { ListenerRecord } from '../../../test-support/recording-target';
import type { GhosttyTerminal } from '../../ghostty-web/ghostty';
import type { ITerminalOptions } from '../../ghostty-web/interfaces';
import type { CanvasRenderer } from '../../ghostty-web/renderer';
import { Terminal } from '../../ghostty-web/terminal';
import { FakeDocument, FakeElement, FakeWindow } from './fake-event-target';
import { rowText, scrollbackText } from './terminal-text';
import { loadGhostty } from './wasm';

/** An open terminal on fakes, what it sent through onData, and its teardown. */
export interface TerminalHarness {
  term: Terminal;
  container: FakeElement;
  doc: FakeDocument;
  win: FakeWindow;
  /** Runs the render loop's frames (`clock.frame()`) and the timeouts set on the window. */
  clock: ManualClock;
  /** Everything onData fired, in order. */
  sent: string[];
  /** The terminal's canvas element, made by open(). */
  canvas: FakeElement;
  /** Disposes the terminal (if the test did not) and restores the globals. */
  close(): void;
}

const GLOBALS = ['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

/** The fakes in the vendored code's globals, and the call that puts the real ones back. */
export interface StubbedGlobals {
  doc: FakeDocument;
  win: FakeWindow;
  clock: ManualClock;
  /** A new container element in the fake document. */
  element(): FakeElement;
  restore(): void;
}

/**
 * Puts a fake document and window, and the clock's animation frames, in the globals the
 * vendored code reads; the window's timeouts run on the clock too.
 */
export function stubGlobals(): StubbedGlobals {
  const g = globalThis as Record<string, unknown>;
  const saved = GLOBALS.map((key) => [key, g[key]] as const);
  const timeline: ListenerRecord[] = [];
  const doc = new FakeDocument(timeline);
  const win = new FakeWindow(timeline);
  const clock = new ManualClock(1000);
  // The scrollbar's auto-hide and the mouse throttle run on the window's timeouts
  Object.assign(win, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  g.document = doc;
  g.window = win;
  g.requestAnimationFrame = clock.requestAnimationFrame;
  g.cancelAnimationFrame = clock.cancelAnimationFrame;
  return {
    doc,
    win,
    clock,
    element: () => new FakeElement('container', 'div', doc),
    restore: () => {
      for (const [key, value] of saved) g[key] = value;
    },
  };
}

/** Opens a terminal on fakes with `options` over a fresh engine; 20 × 5 cells by default. */
export async function openTerminal(
  options: Omit<ITerminalOptions, 'ghostty'> = {},
): Promise<TerminalHarness> {
  const ghostty = await loadGhostty();
  const globals = stubGlobals();
  const container = globals.element();
  const term = new Terminal({ ghostty, cols: 20, rows: 5, ...options });
  const sent: string[] = [];
  term.onData((data) => sent.push(data));
  try {
    term.open(container as unknown as HTMLElement);
  } catch (error) {
    globals.restore();
    throw error;
  }
  const canvas = container.children.find((child) => child.tagName === 'canvas');
  if (!canvas) throw new Error('open() made no canvas');
  return {
    term,
    container,
    doc: globals.doc,
    win: globals.win,
    clock: globals.clock,
    sent,
    canvas,
    close() {
      term.dispose();
      globals.restore();
    },
  };
}

/** The text of the engine's visible rows, as `rowText` reads them. */
export function screenText(term: Terminal): string[] {
  return Array.from({ length: term.rows }, (_, y) => rowText(engineOf(term), y));
}

/** The text of every scrollback line, oldest first. */
export function scrollbackLines(term: Terminal): string[] {
  return Array.from({ length: term.getScrollbackLength() }, (_, i) =>
    scrollbackText(engineOf(term), i),
  );
}

/** The open terminal's engine; throws before open() and after dispose(). */
export function engineOf(term: Terminal): GhosttyTerminal {
  const engine = term.wasmTerm;
  if (!engine) throw new Error('the terminal is not open');
  return engine;
}

/** The open terminal's renderer; throws before open() and after dispose(). */
export function rendererOf(term: Terminal): CanvasRenderer {
  const renderer = term.renderer;
  if (!renderer) throw new Error('the terminal is not open');
  return renderer;
}
