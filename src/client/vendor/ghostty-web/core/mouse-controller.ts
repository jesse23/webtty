// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The terminal's own mouse handling (controller): link hover, throttled to a frame, and
// link clicks; the mouse reports' encoding (ADR 049); and the one right-click route
// (ADR 051). Moved out of terminal.ts (ADR 061).

import { type MouseEventReport, mouseReportText } from '../input/mouse-report';
import {
  type Disposable,
  DisposableStore,
  listen,
} from '../lifecycle/disposable-store';
import type { ILink } from '../link-types';
import { MenuSource, rightClickAction } from '../mouse-route';
import type { MouseHost, TimeoutScheduler } from './host-types';
import { MOUSE_MOVE_THROTTLE_MS } from './terminal-constants';
import {
  linkViewportRange,
  mouseCursorFor,
  mouseSurface,
  pointerCell,
  viewportRowToBufferRow,
} from './terminal-geometry';

/** The page's timeouts, read when called; a timeout is cleared on the window that set it. */
export const browserTimeouts: TimeoutScheduler = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

/**
 * Link hover and click, the mouse report encoder and the context menu, on the listeners
 * Terminal.open() adds after its scrollbar press: move, leave, click, then the menu's
 * press, key and contextmenu.
 */
export class MouseController implements Disposable {
  private hoveredLink?: ILink;
  private throttle?: number;
  private pendingMove?: MouseEvent;
  // Whether a contextmenu came from a button or the keyboard (webtty, ADR 051)
  private readonly menuSource = new MenuSource();
  private listeners?: DisposableStore;

  constructor(
    private readonly host: MouseHost,
    private readonly timeouts: TimeoutScheduler = browserTimeouts,
  ) {}

  /** Adds the container's listeners, in the order Terminal.open() always added them. */
  attach(container: HTMLElement): void {
    const listeners = new DisposableStore();
    this.listeners = listeners;
    listeners.add(listen(container, 'mousemove', this.move));
    listeners.add(listen(container, 'mouseleave', this.leave));
    listeners.add(listen(container, 'click', this.click));
    // Every right-click and keyboard menu goes through contextMenu (webtty, ADR 051)
    listeners.add(listen(container, 'mousedown', this.menuPress, { capture: true }));
    listeners.add(listen(container, 'keydown', this.menuKey, { capture: true }));
    listeners.add(listen(container, 'contextmenu', this.contextMenu, { capture: true }));
  }

  /** Removes the listeners and drops a throttled move. Calling it again does nothing. */
  dispose(): void {
    if (this.throttle) {
      this.timeouts.clearTimeout(this.throttle);
      this.throttle = undefined;
    }
    this.pendingMove = undefined;
    this.listeners?.dispose();
  }

  /**
   * A mouse report at a client position, encoded by Ghostty's mouse encoder in the app's
   * tracking mode and format (`mouseSurface`, `mouseReportText`), or '' when the app does
   * not get one. (webtty, ADR 049)
   */
  encode(event: MouseEventReport): string {
    const host = this.host;
    const px = host.cellPixelSize();
    const engine = host.engine();
    const renderer = host.renderer();
    const canvas = host.canvas();
    const element = host.element();
    if (!engine || !renderer || !canvas || !element || !px) return '';
    const metrics = renderer.getMetrics();
    const rect = canvas.getBoundingClientRect();
    const { geometry, x, y } = mouseSurface(
      event.clientX,
      event.clientY,
      {
        left: rect.left,
        // Viewport row 0 starts the scroll offset below the canvas top (ADR 043)
        top: rect.top + renderer.scrollOffset,
        cols: host.cols(),
        rows: host.rows(),
        cellWidth: metrics.width,
        cellHeight: metrics.height,
      },
      element.getBoundingClientRect(),
      px,
    );
    engine.setMouseGeometry(geometry);
    const { clientX: _x, clientY: _y, ...input } = event;
    return mouseReportText(engine.encodeMouse({ ...input, x, y }));
  }

  /**
   * A move drags the scrollbar at once, or looks for a link under the pointer at most once
   * a throttle period (16 ms, about a frame), so it never holds up scroll events; the last
   * move inside the period is looked at when it ends.
   */
  private readonly move = (e: MouseEvent): void => {
    const host = this.host;
    if (!host.canvas() || !host.renderer() || !host.engine()) return;
    if (host.dragScrollbar(e)) return;
    if (!host.links()) return;
    if (this.throttle) {
      this.pendingMove = e;
      return;
    }
    this.hover(e);
    this.throttle = this.timeouts.setTimeout(() => {
      this.throttle = undefined;
      if (this.pendingMove) {
        const pending = this.pendingMove;
        this.pendingMove = undefined;
        this.hover(pending);
      }
    }, MOUSE_MOVE_THROTTLE_MS);
  };

  /** The link under the pointer, as an absolute buffer row, or undefined before open(). */
  private linkAt(e: MouseEvent): Promise<ILink | undefined> | undefined {
    const host = this.host;
    const canvas = host.canvas();
    const renderer = host.renderer();
    const links = host.links();
    const engine = host.engine();
    if (!canvas || !renderer || !links || !engine) return undefined;
    const { x, y } = pointerCell(e.clientX, e.clientY, canvas.getBoundingClientRect(), renderer);
    const row = viewportRowToBufferRow(y, engine.getScrollbackLength(), host.viewportY());
    return links.getLinkAt(x, row);
  }

  /**
   * Looks for a link under the pointer without waiting for it; a new one gets the hover,
   * the pointer cursor and the renderer's underline.
   */
  private hover(e: MouseEvent): void {
    this.linkAt(e)
      ?.then((link) => {
        if (link !== this.hoveredLink) this.setHovered(link);
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  private setHovered(link: ILink | undefined): void {
    const host = this.host;
    this.hoveredLink?.hover?.(false);
    this.hoveredLink = link;
    link?.hover?.(true);
    // The cursor on both the container and the canvas
    const cursorStyle = mouseCursorFor(link);
    const element = host.element();
    const canvas = host.canvas();
    if (element) element.style.cursor = cursorStyle;
    if (canvas) canvas.style.cursor = cursorStyle;
    // The underline: the link's own range, OSC 8 or regex, while any of it is in view (webtty)
    host
      .renderer()
      ?.setHoveredLinkRange(
        link
          ? linkViewportRange(
              link.range,
              host.engine()?.getScrollbackLength() || 0,
              host.viewportY(),
              host.rows(),
            )
          : null,
      );
  }

  /** The pointer left the container: no link is hovered. */
  private readonly leave = (): void => {
    const host = this.host;
    const renderer = host.renderer();
    if (renderer && host.engine()) renderer.setHoveredLinkRange(null);
    if (!this.hoveredLink) return;
    this.hoveredLink.hover?.(false);
    this.hoveredLink = undefined;
    const element = host.element();
    if (element) {
      element.style.cursor = mouseCursorFor(undefined);
      const canvas = host.canvas();
      if (canvas) canvas.style.cursor = mouseCursorFor(undefined);
    }
  };

  /**
   * Activates the link under a click, looked up at click time rather than taken from the
   * hover, which may not have settled; with Ctrl or Cmd held the click does nothing else.
   */
  private readonly click = async (e: MouseEvent): Promise<void> => {
    const link = await this.linkAt(e);
    if (!link) return;
    link.activate(e);
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };

  private readonly menuPress = (e: MouseEvent): void => {
    this.menuSource.press(e);
  };

  private readonly menuKey = (): void => {
    this.menuSource.key();
  };

  /**
   * The one place a right-click or a keyboard menu is handled. A right button the app
   * takes (it tracks the mouse, Shift is up) is the app's: its press and release were
   * reported, and the menu is cancelled. Otherwise `rightClickBehavior` decides: the
   * browser menu, copy and clear the selection, paste, or nothing. (webtty: upstream
   * always showed the menu, from the selection manager, ADR 051)
   */
  private readonly contextMenu = (e: MouseEvent): void => {
    const host = this.host;
    const selection = host.selection();
    const behavior = host.rightClickBehavior();
    const action = rightClickAction({
      tracking: host.engine()?.hasMouseTracking() ?? false,
      shiftKey: e.shiftKey,
      fromKeyboard: this.menuSource.fromKeyboard(e),
      behavior,
      hasSelection: behavior === 'copyPaste' && (selection?.getSelection() || '') !== '',
    });
    if (action === 'menu') {
      selection?.prepareContextMenu(e);
      return;
    }
    e.preventDefault();
    if (action === 'copy') {
      selection?.copySelection();
      selection?.clearSelection();
    } else if (action === 'paste') {
      host.requestPaste();
    }
  };
}
