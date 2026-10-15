// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal's controllers, made and wired in one place (composition): focus, find, writes,
// the render loop, the viewport, the scrollbar, the mouse and the wheel, each reaching the
// terminal and the others only through the hosts given here (ADR 061).

import type { ListenerTarget } from '../lifecycle/disposable-store';
import type { RightClickBehavior } from '../mouse-route';
import { FindController } from './find-controller';
import { FocusTracker } from './focus-tracker';
import type {
  FindHost,
  FocusHost,
  FrameScheduler,
  MouseHost,
  RenderLoopHost,
  ScrollbarHost,
  TimeoutScheduler,
  WheelHost,
  WriteHost,
} from './host-types';
import { MouseController } from './mouse-controller';
import type { OpenedParts } from './opened-parts';
import { RenderLoop } from './render-loop';
import { ScrollbarController } from './scrollbar-controller';
import type { TerminalEmitters } from './terminal-emitters';
import { Viewport } from './viewport';
import { WheelController } from './wheel-controller';
import { WritePipeline } from './write-pipeline';

/** What the controllers read of Terminal's public surface, each read made when needed. */
export interface ControllersHost {
  readonly options: {
    readonly disableStdin: boolean;
    readonly rightClickBehavior: RightClickBehavior;
    readonly mouseScrollSpeed: number;
  };
  readonly cols: number;
  readonly rows: number;
  readonly viewportY: number;
  getScrollbackLength(): number;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
}

/** Terminal's private state and steps the controllers reach. */
export interface ControllersInternalsHost {
  readonly emit: TerminalEmitters;
  /** The parts open() made; undefined before it and after dispose(). */
  parts(): OpenedParts | undefined;
  /** Open and not disposed. */
  live(): boolean;
  /** The embedder's callback (attachBeforeRender). */
  beforeRender(now: number): void;
  /** Fires onTitleChange if the title changed. */
  setTitle(title: string): void;
  /** Renders now if open, the scrollbar at `opacity` (its current one when not given). */
  render(force: boolean, opacity?: number): void;
  anchorTextarea(): void;
  /** The renderer's cell in whole device pixels, or null before open() (ADR 042). */
  cellPixelSize(): { width: number; height: number } | null;
}

/**
 * One clock for every controller's frames, timeouts and time, injected so tests run them
 * by hand; without it each controller uses the browser's.
 */
export interface ControllersClock extends FrameScheduler, TimeoutScheduler {
  now(): number;
}

/** Terminal's controllers, built in the constructor, attached in open(), disposed together. */
export class TerminalControllers {
  /** Focus kept off the container and reported to the app under mode 1004 (ADR 053). */
  readonly focus: FocusTracker;
  /** Find in the scrollback, stepped by the render loop (ADR 055). */
  readonly finder: FindController;
  /** Output into the engine and every step after it, in a fixed order. */
  readonly writes: WritePipeline;
  /** One frame after another while open, each in a fixed order. */
  readonly renderLoop: RenderLoop;
  /** Where the view is in the scrollback; each move fires onScroll and shows the scrollbar. */
  readonly viewport: Viewport;
  /** The scrollbar's press, drag and fade (ADR 043). */
  readonly scrollbar: ScrollbarController;
  /** Link hover and clicks, the mouse report encoder and the right-click route (ADR 049, ADR 051). */
  readonly mouse: MouseController;
  /** Wheel events to the embedder, or to the app as ticks or arrows (ADR 045, ADR 049). */
  readonly wheel: WheelController;

  constructor(
    private readonly term: ControllersHost,
    private readonly inner: ControllersInternalsHost,
    clock?: ControllersClock,
  ) {
    this.focus = new FocusTracker(focusHost(term, inner), clock);
    this.finder = new FindController(findHost(term, inner), clock?.now);
    this.writes = new WritePipeline(writeHost(term, inner, this), clock);
    this.renderLoop = new RenderLoop(renderLoopHost(inner, this), clock, clock?.now);
    this.viewport = new Viewport({
      getScrollbackLength: () => term.getScrollbackLength(),
      scrolled: (viewportY) => inner.emit.scroll.fire(viewportY),
      showScrollbar: () => this.scrollbar.show(),
    });
    this.scrollbar = new ScrollbarController(scrollbarHost(term, inner), clock);
    this.mouse = new MouseController(mouseHost(term, inner, this), clock);
    this.wheel = new WheelController(wheelHost(term, inner, this));
  }

  /**
   * Input from the InputHandler. Keys and text clear the selection and scroll to the
   * bottom; a mouse report leaves both alone, so a Shift selection outlives the app's
   * hover and clicks. (webtty, ADR 051, ADR 055)
   */
  input(data: string, mouseReport = false): void {
    if (this.term.options.disableStdin) return;
    if (!mouseReport) {
      this.inner.parts()?.selection.clearSelection();
      // Ghostty's `scroll-to-bottom = keystroke`, which output no longer does while a
      // match is selected (webtty, ADR 055)
      this.term.scrollToBottom();
    }
    this.writes.awaitEcho();
    this.inner.emit.data.fire(data);
  }

  /**
   * Adds the listeners open() adds after its parts, in the order it always has: the
   * scrollbar press, the mouse's, the document's mouseup that ends a scrollbar drag, then
   * the wheel.
   */
  attach(container: HTMLElement, doc: ListenerTarget): void {
    // Scrollbar presses, in the capture phase, before SelectionManager sees them
    this.scrollbar.attach(container);
    // Link hover and clicks, then the right-click route (webtty, ADR 051)
    this.mouse.attach(container);
    // A scrollbar drag ends wherever the button is released
    this.scrollbar.watchRelease(doc);
    // Wheel events, in the capture phase before the browser scrolls
    this.wheel.attach(container);
  }

  /**
   * Removes every listener the controllers added, with the next frame of the render loop,
   * the wheel's queued ticks, the
   * mouse's throttled move, the scrollbar's auto-hide and fade, the focus tracker's
   * refocus and the write callbacks not run yet (ADR 065). Calling it again does nothing.
   */
  detach(): void {
    this.renderLoop.cancel();
    this.wheel.dispose();
    this.mouse.dispose();
    this.scrollbar.dispose();
    this.focus.dispose();
    this.writes.dispose();
  }
}

// Each controller's host, read when called: the parts are undefined before open() and
// after dispose(), and the other controllers are reached through `core` once all exist.

type Inner = ControllersInternalsHost;

function focusHost(term: ControllersHost, inner: Inner): FocusHost {
  return {
    element: () => inner.parts()?.element,
    textarea: () => inner.parts()?.textarea,
    engine: () => inner.parts()?.engine,
    disableStdin: () => term.options.disableStdin,
    send: (data) => inner.emit.data.fire(data),
  };
}

function findHost(term: ControllersHost, inner: Inner): FindHost {
  return {
    engine: () => inner.parts()?.engine,
    highlight: (highlights) => inner.parts()?.renderer.setSearchHighlights(highlights),
    getScrollbackLength: () => term.getScrollbackLength(),
    viewportY: () => term.viewportY,
    rows: () => term.rows,
    scrollToLine: (line) => term.scrollToLine(line),
    changed: (state) => inner.emit.findChange.fire(state),
  };
}

function writeHost(term: ControllersHost, inner: Inner, core: TerminalControllers): WriteHost {
  return {
    engine: () => inner.parts()?.engine,
    disableStdin: () => term.options.disableStdin,
    send: (data) => inner.emit.data.fire(data),
    followFocusMode: () => core.focus.followMode(),
    bell: () => inner.emit.bell.fire(),
    title: (title) => inner.setTitle(title),
    clipboardWrite: (text) => inner.emit.clipboardWrite.fire(text),
    notify: (notification) => inner.emit.desktopNotification.fire(notification),
    outputChanged: () => inner.parts()?.links.invalidateCache(),
    viewportY: () => term.viewportY,
    findAnchored: () => core.finder.anchored,
    scrollToBottom: () => term.scrollToBottom(),
    renderEcho: () => inner.render(false),
  };
}

function renderLoopHost(inner: Inner, core: TerminalControllers): RenderLoopHost {
  return {
    live: () => inner.live(),
    beforeRender: (now) => inner.beforeRender(now),
    stepFind: (now) => core.finder.step(now),
    render: () => inner.render(false),
    hasReplies: () => inner.parts()?.engine.hasResponse() ?? false,
    drainReplies: () => core.writes.drainReplies(),
    anchorTextarea: () => inner.anchorTextarea(),
  };
}

function scrollbarHost(term: ControllersHost, inner: Inner): ScrollbarHost {
  return {
    canvas: () => inner.parts()?.canvas,
    scrollOffset: () => inner.parts()?.renderer.scrollOffset,
    getScrollbackLength: () => term.getScrollbackLength(),
    rows: () => term.rows,
    viewportY: () => term.viewportY,
    scrollToLine: (line) => term.scrollToLine(line),
    render: (opacity) => inner.render(false, opacity),
  };
}

function mouseHost(term: ControllersHost, inner: Inner, core: TerminalControllers): MouseHost {
  return {
    element: () => inner.parts()?.element,
    canvas: () => inner.parts()?.canvas,
    engine: () => inner.parts()?.engine,
    renderer: () => inner.parts()?.renderer,
    links: () => inner.parts()?.links,
    selection: () => inner.parts()?.selection,
    rows: () => term.rows,
    cols: () => term.cols,
    viewportY: () => term.viewportY,
    cellPixelSize: () => inner.cellPixelSize(),
    rightClickBehavior: () => term.options.rightClickBehavior,
    dragScrollbar: (e) => core.scrollbar.drag(e),
    requestPaste: () => inner.emit.pasteRequest.fire(),
  };
}

function wheelHost(term: ControllersHost, inner: Inner, core: TerminalControllers): WheelHost {
  return {
    engine: () => inner.parts()?.engine,
    cellHeight: () => inner.parts()?.renderer.getMetrics()?.height,
    hasCanvas: () => !!inner.parts()?.canvas,
    rows: () => term.rows,
    mouseScrollSpeed: () => term.options.mouseScrollSpeed,
    encodeMouse: (event) => core.mouse.encode(event),
    send: (data) => inner.emit.data.fire(data),
  };
}
