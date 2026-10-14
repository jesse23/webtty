// A SelectionManager on fakes (test fake, ADR 064): a recording canvas and document, a
// clipboard that keeps what is written, and a manual clock for the auto-scroll, all
// injected, so selection tests dispatch mouse events by hand and stub no globals.

import { ManualClock } from '../../../test-support/manual-clock';
import { RecordingTarget } from '../../../test-support/recording-target';
import type { SelectionEngineSource, SelectionHost } from '../../ghostty-web/core/host-types';
import type { ClipboardEnv } from '../../ghostty-web/selection/clipboard-copy';
import type { ClientRect } from '../../ghostty-web/selection/selection-coords';
import { SelectionManager } from '../../ghostty-web/selection-manager';

/** Cell size of every fixture canvas, in CSS pixels. */
export const CELL = { width: 8, height: 16 };

/** A canvas: a recording target with a client rectangle and a focusable parent. */
export class FakeCanvas extends RecordingTarget {
  readonly parentElement = { focused: 0, focus: () => void this.parentElement.focused++ };
  /** Nodes `contains` says are inside the canvas, besides itself. */
  readonly inside = new Set<unknown>();

  constructor(
    readonly rect: ClientRect,
    name = 'canvas',
  ) {
    super(name);
  }

  get clientHeight(): number {
    return this.rect.bottom - this.rect.top;
  }

  getBoundingClientRect(): ClientRect {
    return this.rect;
  }

  contains(node: unknown): boolean {
    return node === this || this.inside.has(node);
  }
}

/** A textarea that records its listeners and the focus and selection calls made on it. */
export class FakeTextarea extends RecordingTarget {
  value = '';
  readonly style: Record<string, string> = {};
  readonly calls: string[] = [];

  constructor() {
    super('textarea');
  }

  focus(): void {
    this.calls.push('focus');
  }

  select(): void {
    this.calls.push('select');
  }

  setSelectionRange(start: number, end: number): void {
    this.calls.push(`range ${start}-${end}`);
  }

  /** Typed as the element the code under test takes. */
  get element(): HTMLTextAreaElement {
    return this as unknown as HTMLTextAreaElement;
  }
}

export interface SelectionFixtureOptions {
  copyOnSelect?: boolean;
  /** Lines scrolled into history; 0 by default. */
  viewportY?: () => number;
}

/** A manager over `engine`, sized to it, with every collaborator a fake the test reads. */
export function selectionFixture(
  engine: SelectionEngineSource & { cols: number; rows: number },
  options: SelectionFixtureOptions = {},
) {
  const canvas = new FakeCanvas({
    left: 0,
    top: 0,
    right: engine.cols * CELL.width,
    bottom: engine.rows * CELL.height,
  });
  const doc = new RecordingTarget('document');
  const clock = new ManualClock();
  const writes: string[] = [];
  const scrolls: number[] = [];
  const host: SelectionHost = {
    cols: engine.cols,
    rows: engine.rows,
    options: { copyOnSelect: options.copyOnSelect ?? false },
    getViewportY: options.viewportY ?? (() => 0),
    scrollLines: (amount) => void scrolls.push(amount),
  };
  const textarea = new FakeTextarea();
  const clipboard: ClipboardEnv = {
    clipboard: { writeText: async (text: string) => void writes.push(text) },
    document: { activeElement: null, execCommand: () => true },
    textarea: textarea.element,
    warn: () => {},
  };
  const m = new SelectionManager(
    host,
    {
      getCanvas: () => canvas as unknown as HTMLCanvasElement,
      getMetrics: () => CELL,
      scrollOffset: 0,
    },
    engine,
    textarea.element,
    {
      document: doc as unknown as Document,
      timers: clock,
      setTimeout: clock.setTimeout,
      clipboard: () => clipboard,
    },
  );
  let changes = 0;
  m.onSelectionChange(() => changes++);
  return { m, canvas, doc, textarea, clock, writes, scrolls, changes: () => changes };
}

/** Dispatches a mouse event of `type` with `init` on a recording target. */
export function fire(target: RecordingTarget, type: string, init: object = {}): void {
  target.dispatch({ type, ...init });
}

/** The event fields of a press or move at cell (col, row), a few pixels into the cell. */
export function atCell(col: number, row: number): { offsetX: number; offsetY: number } {
  return { offsetX: col * CELL.width + 1, offsetY: row * CELL.height + 4 };
}
