// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The terminal's scrollbar (controller): a press on the track jumps, a press on the thumb
// drags, and each scroll fades it in, then out after a pause; the hit test is the
// painter's geometry (render/scrollbar-geometry.ts). Moved out of terminal.ts (ADR 061).

import { DisposableStore, listen, type ListenerTarget } from '../lifecycle/disposable-store';
import {
  inScrollbarColumn,
  SCROLLBAR_PADDING,
  scrollbarThumbHeight,
  scrollbarThumbY,
  scrollbarTrackHeight,
} from '../render/scrollbar-geometry';
import type { ScrollbarClock, ScrollbarHost } from './host-types';
import { SCROLLBAR_FADE_DURATION_MS, SCROLLBAR_HIDE_DELAY_MS } from './terminal-constants';

/** The browser's clock, timeouts and frames, read when called. */
export const browserScrollbarClock: ScrollbarClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
};

/**
 * The scrollbar's press, drag and visibility. The press listener is added in the capture
 * phase, before SelectionManager's, so a press on the scrollbar never starts a selection.
 */
export class ScrollbarController {
  private dragging = false;
  private dragStartY: number | null = null;
  private dragStartViewportY = 0;
  private visible = false;
  private shownOpacity = 0;
  private hideTimeout?: number;
  private listeners?: DisposableStore;
  private releaseTarget?: ListenerTarget;

  constructor(
    private readonly host: ScrollbarHost,
    private readonly clock: ScrollbarClock = browserScrollbarClock,
  ) {}

  /** The opacity every render paints the scrollbar at: 0 hidden, 1 shown. */
  get opacity(): number {
    return this.shownOpacity;
  }

  /** Adds the container's capture press, at the position Terminal.open() always added it. */
  attach(container: HTMLElement): void {
    const listeners = new DisposableStore();
    this.listeners = listeners;
    listeners.add(listen(container, 'mousedown', this.press, { capture: true }));
  }

  /**
   * Adds the document's mouseup, so a drag ends even when released outside the canvas;
   * open() adds it after the mouse controller's listeners.
   */
  watchRelease(doc: ListenerTarget): void {
    this.releaseTarget = doc;
    // leaks until ADR 065
    doc.addEventListener('mouseup', this.release);
  }

  /**
   * Removes the document's mouseup. Terminal calls it only while open, which its teardown
   * never is, so today it leaks (ADR 065).
   */
  unwatchRelease(): void {
    this.releaseTarget?.removeEventListener('mouseup', this.release);
  }

  /** Removes the press listener and the pending auto-hide. Calling it again does nothing. */
  dispose(): void {
    this.listeners?.dispose();
    this.cancelHide();
  }

  /** Moves a drag in progress to `e`; true when there was one and the move is used up. */
  drag(e: MouseEvent): boolean {
    if (!this.dragging) return false;
    this.dragTo(e);
    return true;
  }

  /** Fades the scrollbar in, or keeps it shown, and hides it after a pause unless dragged. */
  show(): void {
    this.cancelHide();
    if (!this.visible) {
      this.visible = true;
      this.shownOpacity = 0;
      this.fade('in');
    } else {
      this.shownOpacity = 1;
    }
    if (!this.dragging) {
      this.hideTimeout = this.clock.setTimeout(() => this.hide(), SCROLLBAR_HIDE_DELAY_MS);
    }
  }

  /** A press in the scrollbar's column: on the thumb it starts a drag, on the track it jumps. */
  private readonly press = (e: MouseEvent): void => {
    const canvas = this.host.canvas();
    const scrollOffset = this.host.scrollOffset();
    if (!canvas || scrollOffset === undefined) return;
    const scrollbackLength = this.host.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = canvas.getBoundingClientRect();
    // The scrollbar is painted over the rows in view (webtty, ADR 043)
    const mouseY = e.clientY - rect.top - scrollOffset;
    if (!inScrollbarColumn(e.clientX - rect.left, rect.width)) return;
    e.preventDefault();
    e.stopPropagation();
    // SelectionManager never sees a press on the scrollbar
    e.stopImmediatePropagation();

    const trackHeight = scrollbarTrackHeight(rect.height);
    const thumbHeight = scrollbarThumbHeight(this.host.rows(), scrollbackLength, trackHeight);
    const viewportY = this.host.viewportY();
    const thumbY = scrollbarThumbY(viewportY, scrollbackLength, trackHeight, thumbHeight);
    if (mouseY >= thumbY && mouseY <= thumbY + thumbHeight) {
      this.dragging = true;
      this.dragStartY = mouseY;
      this.dragStartViewportY = viewportY;
      // No text selection while dragging
      canvas.style.userSelect = 'none';
      canvas.style.webkitUserSelect = 'none';
    } else {
      // The track: top is the start of the scrollback, bottom the current output
      const scrollFraction = 1 - (mouseY - SCROLLBAR_PADDING) / trackHeight;
      const target = Math.round(scrollFraction * scrollbackLength);
      this.host.scrollToLine(Math.max(0, Math.min(scrollbackLength, target)));
    }
  };

  /** The end of a drag: text selection comes back and the auto-hide starts again. */
  private readonly release = (): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.dragStartY = null;
    const canvas = this.host.canvas();
    if (canvas) {
      canvas.style.userSelect = '';
      canvas.style.webkitUserSelect = '';
    }
    if (this.visible && this.host.getScrollbackLength() > 0) this.show();
  };

  /** Moves the view by the thumb's travel since the press, in proportion to the scrollback. */
  private dragTo(e: MouseEvent): void {
    const canvas = this.host.canvas();
    const scrollOffset = this.host.scrollOffset();
    if (!canvas || scrollOffset === undefined || this.dragStartY === null) return;
    const scrollbackLength = this.host.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = canvas.getBoundingClientRect();
    const deltaY = e.clientY - rect.top - scrollOffset - this.dragStartY;
    const trackHeight = scrollbarTrackHeight(rect.height);
    const thumbHeight = scrollbarThumbHeight(this.host.rows(), scrollbackLength, trackHeight);
    // The thumb moves against the view: thumb down is viewportY down
    const scrollFraction = -deltaY / (trackHeight - thumbHeight);
    const target = this.dragStartViewportY + Math.round(scrollFraction * scrollbackLength);
    this.host.scrollToLine(Math.max(0, Math.min(scrollbackLength, target)));
  }

  private hide(): void {
    this.cancelHide();
    if (this.visible) this.fade('out');
  }

  private cancelHide(): void {
    if (this.hideTimeout) {
      this.clock.clearTimeout(this.hideTimeout);
      this.hideTimeout = undefined;
    }
  }

  /**
   * Fades in from 0, or out from the current opacity, over SCROLLBAR_FADE_DURATION_MS,
   * rendering each frame. A fade out ends hidden, with one more render at opacity 0 to clear
   * it. The frames are not cancelled on dispose(): they run out within the fade, rendering
   * nothing once the terminal is closed.
   */
  private fade(direction: 'in' | 'out'): void {
    const start = this.clock.now();
    const from = this.shownOpacity;
    const animate = () => {
      const progress = Math.min((this.clock.now() - start) / SCROLLBAR_FADE_DURATION_MS, 1);
      this.shownOpacity = direction === 'in' ? progress : from * (1 - progress);
      this.host.render(this.shownOpacity);
      if (progress < 1) {
        this.clock.requestAnimationFrame(animate);
      } else if (direction === 'out') {
        this.visible = false;
        this.shownOpacity = 0;
        this.host.render(0);
      }
    };
    animate();
  }
}
