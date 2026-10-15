// Derived from coder/ghostty-web lib/selection-manager.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Mouse selection gestures (object): a press and drag on the canvas, a drag past its edge
// (auto-scroll), double and triple clicks, and a click outside to clear, turned into
// calls on a GestureHost (ADR 050, ADR 051, ADR 057, ADR 061); dispose() removes every
// listener it added (ADR 065).

import type { ScreenRange } from '../engine/engine-types';
import {
  type Disposable,
  DisposableStore,
  type ListenerTarget,
  listen,
} from '../lifecycle/disposable-store';
import { AUTO_SCROLL_LINES, AutoScroll, type AutoScrollTimers, extendedEnd } from './auto-scroll';
import {
  type BufferPoint,
  type ClientRect,
  clampedOffset,
  outsideRect,
  pastDragThreshold,
  verticalOverflow,
} from './selection-coords';

/** The canvas the gestures listen on. */
export interface GestureCanvas
  extends Pick<HTMLElement, 'addEventListener' | 'removeEventListener' | 'contains' | 'clientHeight'> {
  getBoundingClientRect(): ClientRect;
  readonly parentElement: Pick<HTMLElement, 'focus'> | null;
}

/** The document the gestures follow a drag and outside clicks on. */
export type GestureDocument = Pick<Document, 'addEventListener' | 'removeEventListener'>;

/** What a gesture reads and changes: the grid under the pointer and the selection. */
export interface GestureHost {
  /** The cell under a canvas-relative pixel position, as a buffer point. */
  pointAt(offsetX: number, offsetY: number): BufferPoint;
  /** The cell width in CSS pixels; half of it is the drag threshold. */
  cellWidth(): number;
  /** Whether the app takes this press: it tracks the mouse and Shift is up (webtty, ADR 051). */
  appTakesPress(e: MouseEvent): boolean;
  /**
   * The range a multi-click selects at a point: a word for 2 clicks, a line for 3, or with
   * Ctrl or Cmd the command's output (Ghostty's rules, ADR 050 and webtty ADR 057).
   */
  clickRange(clicks: number, at: BufferPoint, e: MouseEvent): ScreenRange | null;
  /** Scrolls the viewport; negative is up into history. */
  scrollLines(amount: number): void;
  /** The visible rows as absolute rows, and the last column. */
  visibleRows(): { top: number; bottom: number; lastCol: number };
  hasSelection(): boolean;
  clearSelection(): void;
  /** Sets both selection ends. */
  select(start: BufferPoint, end: BufferPoint): void;
  /** The selection's moving end, or null with no selection. */
  selectionEnd(): BufferPoint | null;
  /** Moves the selection's moving end. */
  extendTo(end: BufferPoint): void;
  /** A gesture has finished making a selection. */
  selectionMade(): void;
}

/**
 * Listens on the canvas and the document and drives the selection through the host. It
 * owns the drag: whether a press is selecting, where it started, whether it moved past
 * the threshold, and the auto-scroll.
 */
export class SelectionGestures implements Disposable {
  private selecting = false;
  private downX = 0;
  private downY = 0;
  private thresholdMet = false;
  private downTarget: EventTarget | null = null;
  private readonly autoScroll: AutoScroll;
  private readonly listeners = new DisposableStore();

  constructor(
    private readonly canvas: GestureCanvas,
    private readonly doc: GestureDocument,
    private readonly host: GestureHost,
    timers?: AutoScrollTimers,
  ) {
    this.autoScroll = new AutoScroll((direction) => this.autoScrollStep(direction), timers);
    this.attach();
  }

  /** A press is down but has not moved past the threshold: no selection is shown yet. */
  get pressPending(): boolean {
    return this.selecting && !this.thresholdMet;
  }

  /** Ends a drag in progress, so later moves and the release change nothing. */
  endDrag(): void {
    this.selecting = false;
  }

  /** Stops the auto-scroll and removes every listener (ADR 065). Calling it again does nothing. */
  dispose(): void {
    this.autoScroll.stop();
    this.listeners.dispose();
  }

  /** Adds the listeners in upstream's order, which the listener snapshot pins (ADR 064). */
  private attach(): void {
    const { canvas, doc, listeners } = this;
    const on = (target: ListenerTarget, type: string, handle: (e: MouseEvent) => void) =>
      listeners.add(listen(target, type, (e) => handle(e as MouseEvent)));
    on(canvas, 'mousedown', (e) => this.canvasDown(e));
    on(canvas, 'mousemove', (e) => this.canvasMove(e));
    on(canvas, 'mouseleave', (e) => {
      // Leaving the canvas mid-drag scrolls toward the side it left by
      const direction = this.selecting
        ? verticalOverflow(canvas.getBoundingClientRect(), e.clientY)
        : 0;
      if (direction !== 0) this.autoScroll.start(direction);
    });
    on(canvas, 'mouseenter', () => {
      if (this.selecting) this.autoScroll.stop();
    });
    on(doc, 'mousemove', (e) => this.documentMove(e));
    // Where a press started, so a click that began inside the canvas does not clear
    on(doc, 'mousedown', (e) => {
      this.downTarget = e.target;
    });
    // A release on the document, not the canvas, so one outside the canvas ends the drag
    on(doc, 'mouseup', () => this.release());
    on(canvas, 'click', (e) => this.multiClick(e));
    on(doc, 'click', (e) => this.documentClick(e));
  }

  /** A left press starts a selection, clearing the old one; it focuses the terminal first. */
  private canvasDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    // The canvas has no tabindex; its parent, the container, takes keyboard focus
    this.canvas.parentElement?.focus();
    // A press the app takes (it tracks the mouse, Shift is up) starts no selection
    // and leaves the current one; Shift selects here instead. (webtty, ADR 051)
    if (this.host.appTakesPress(e)) return;
    const point = this.host.pointAt(e.offsetX, e.offsetY);
    if (this.host.hasSelection()) this.host.clearSelection();
    this.host.select(point, point);
    this.selecting = true;
    this.downX = e.offsetX;
    this.downY = e.offsetY;
    this.thresholdMet = false;
  }

  /** A drag on the canvas moves the selection's end and scrolls near the edges. */
  private canvasMove(e: MouseEvent): void {
    if (!this.selecting) return;
    if (!this.passedThreshold(e.offsetX - this.downX, e.offsetY - this.downY)) return;
    this.host.extendTo(this.host.pointAt(e.offsetX, e.offsetY));
    this.autoScroll.followEdge(e.offsetY, this.canvas.clientHeight);
  }

  /**
   * A drag outside the canvas scrolls when above or below it; when not scrolling, the
   * selection's end follows the pointer clamped to the canvas edge. While scrolling, the
   * scroll step extends the selection instead.
   */
  private documentMove(e: MouseEvent): void {
    if (!this.selecting) return;
    const rect = this.canvas.getBoundingClientRect();
    const dx = e.clientX - (rect.left + this.downX);
    const dy = e.clientY - (rect.top + this.downY);
    if (!this.passedThreshold(dx, dy)) return;
    if (!outsideRect(rect, e.clientX, e.clientY)) return;
    const direction = verticalOverflow(rect, e.clientY);
    if (direction === 0) this.autoScroll.stop();
    else this.autoScroll.start(direction);
    if (this.autoScroll.direction === 0) {
      const { offsetX, offsetY } = clampedOffset(rect, e.clientX, e.clientY);
      this.host.extendTo(this.host.pointAt(offsetX, offsetY));
    }
  }

  /** Whether the press has become a drag, marking it the first time it moves far enough. */
  private passedThreshold(dx: number, dy: number): boolean {
    if (this.thresholdMet) return true;
    if (!pastDragThreshold(dx, dy, this.host.cellWidth())) return false;
    this.thresholdMet = true;
    return true;
  }

  /** The release ends the drag; a press that never became a drag clears the selection. */
  private release(): void {
    if (!this.selecting) return;
    this.selecting = false;
    this.autoScroll.stop();
    if (!this.thresholdMet) {
      this.host.clearSelection();
      return;
    }
    if (this.host.hasSelection()) this.host.selectionMade();
  }

  /**
   * A double click selects a word and a triple click a line, by Ghostty's rules (ADR 050);
   * with Ctrl or Cmd, a triple click selects the command's output (webtty, ADR 057).
   * `detail` is the browser's click count. Not while the app takes the press (webtty, ADR 051).
   */
  private multiClick(e: MouseEvent): void {
    if (e.detail < 2) return;
    if (this.host.appTakesPress(e)) return;
    const range = this.host.clickRange(e.detail, this.host.pointAt(e.offsetX, e.offsetY), e);
    if (!range) return;
    this.host.select(
      { col: range.start.col, absoluteRow: range.start.row },
      { col: range.end.col, absoluteRow: range.end.row },
    );
    this.host.selectionMade();
  }

  /**
   * A click with both its press and release outside the canvas clears the selection, so
   * clicking anywhere else deselects; one ending a drag that began inside does not.
   */
  private documentClick(e: MouseEvent): void {
    if (this.selecting) return;
    if (this.downTarget && this.canvas.contains(this.downTarget as Node)) return;
    if (!this.canvas.contains(e.target as Node) && this.host.hasSelection()) {
      this.host.clearSelection();
    }
  }

  /** One auto-scroll step: scroll, then extend the selection to the newly visible edge. */
  private autoScrollStep(direction: -1 | 1): void {
    if (!this.selecting) {
      this.autoScroll.stop();
      return;
    }
    this.host.scrollLines(AUTO_SCROLL_LINES * direction);
    const end = this.host.selectionEnd();
    if (!end) return;
    const extended = extendedEnd(end, direction, this.host.visibleRows());
    if (extended) this.host.extendTo(extended);
  }
}
