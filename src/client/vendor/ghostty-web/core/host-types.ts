// webtty (ADR 061), not from upstream.
// What Terminal's collaborators see of it (types): narrow interfaces instead of the
// Terminal, CanvasRenderer and engine classes, so a split part never imports a facade and
// no import cycle forms (ADR 061).

import type {
  DesktopNotification,
  GhosttyTerminal,
  SearchState,
} from '../engine/engine-types';
import type { MouseEventReport } from '../input/mouse-report';
import type { ILink } from '../link-types';
import type { RightClickBehavior } from '../mouse-route';
import type { SearchHighlights } from '../search';
import type { ViewportLinkRange } from './terminal-geometry';

/**
 * What SelectionManager needs from the terminal: its size, the copyOnSelect option, the
 * viewport position, and scrolling for the drag auto-scroll.
 */
export interface SelectionHost {
  readonly cols: number;
  readonly rows: number;
  readonly options: { readonly copyOnSelect?: boolean };
  /** Lines scrolled into history; fractional while smooth scrolling. */
  getViewportY(): number;
  scrollLines(amount: number): void;
}

/**
 * What SelectionManager reads from the renderer: the canvas it listens on, the cell size,
 * and how far row 0 sits below the canvas top while smooth scrolling (ADR 043).
 */
export interface SelectionCanvasSource {
  getCanvas(): HTMLCanvasElement;
  getMetrics(): { width: number; height: number };
  readonly scrollOffset: number;
}

/**
 * The engine calls a selection makes: Ghostty's word, line and output ranges and the
 * selected text (ADR 050, ADR 057), mouse tracking (ADR 051), and the grid's size.
 */
export type SelectionEngineSource = Pick<
  GhosttyTerminal,
  | 'getScrollbackLength'
  | 'getDimensions'
  | 'hasMouseTracking'
  | 'selectWord'
  | 'selectLine'
  | 'selectOutput'
  | 'selectionText'
>;

/**
 * What the Viewport needs from the terminal: the scrollback length it clamps to, where a
 * move is announced (onScroll), and the scrollbar it shows while scrolling.
 */
export interface ViewportHost {
  getScrollbackLength(): number;
  /**
   * Whether the renderer shows part of the row above the view, from the next frame on: a
   * smooth scroll's sub-line offset (CanvasRenderer.requestedOffset), which the embedder
   * sets, not the Viewport.
   */
  partRowShown(): boolean;
  /** The view moved to `viewportY`. */
  scrolled(viewportY: number): void;
  showScrollbar(): void;
}

/**
 * The frame clock the render loop and the write callbacks run on, injected so tests step
 * frames by hand; production passes the browser's (`browserFrames` in render-loop.ts).
 */
export interface FrameScheduler {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(id: number): void;
}

/**
 * What the FocusTracker reads of the terminal, each call made when an event arrives: the
 * container and textarea (undefined before open() and after dispose()), the engine that
 * reads mode 1004 and encodes the report, and where a report goes (ADR 053).
 */
export interface FocusHost {
  element(): HTMLElement | undefined;
  textarea(): HTMLTextAreaElement | undefined;
  engine(): Pick<GhosttyTerminal, 'getMode' | 'encodeFocus'> | undefined;
  disableStdin(): boolean;
  /** Sends bytes to the app, as onData. */
  send(data: string): void;
}

/** The engine calls a search makes: libghostty-vt's search (ADR 055). */
export type FindEngine = Pick<
  GhosttyTerminal,
  | 'setSearch'
  | 'searchStep'
  | 'searchSelect'
  | 'searchState'
  | 'searchSelectedMatch'
  | 'searchMatches'
>;

/**
 * What the FindController needs from the terminal: the engine's search, the renderer's
 * highlights, the view it scrolls to a match, and where a new count goes (onFindChange).
 */
export interface FindHost {
  engine(): FindEngine | undefined;
  /** Hands the renderer the matches, or null to clear them. */
  highlight(highlights: SearchHighlights | null): void;
  getScrollbackLength(): number;
  viewportY(): number;
  rows(): number;
  scrollToLine(line: number): void;
  /** The match count or the selected match changed. */
  changed(state: SearchState): void;
}

/** The engine calls a write makes: the VT write, the clear's checks, replies and effects. */
export type WriteEngine = Pick<
  GhosttyTerminal,
  | 'write'
  | 'writeUntilGround'
  | 'isAlternateScreen'
  | 'cursorAtPrompt'
  | 'getCursor'
  | 'readResponse'
  | 'readEffects'
>;

/**
 * What the WritePipeline reaches of the terminal, one call per step of a write: the
 * engine, the app (onData), the focus-mode edge, the effects' emitters, the link cache,
 * the view and the echo render.
 */
export interface WriteHost {
  engine(): WriteEngine | undefined;
  disableStdin(): boolean;
  /** Sends bytes to the app, as onData: replies, and FF after a clear at a prompt. */
  send(data: string): void;
  /** Reports the focus if the write turned mode 1004 on (FocusTracker.followMode). */
  followFocusMode(): void;
  bell(): void;
  title(title: string): void;
  clipboardWrite(text: string): void;
  notify(notification: DesktopNotification): void;
  /** The content changed: the link cache is stale. */
  outputChanged(): void;
  /** Whether the view is kept on a selected find match (FindController.anchored). */
  findAnchored(): boolean;
  scrollToBottom(): void;
  /**
   * Pins Ghostty's viewport on the view's text for the write that follows; false, pinning
   * nothing, when the view is at the bottom (Viewport.pin).
   */
  pinView(): boolean;
  /** After the write, moves the view to where the pin went with its text (Viewport.unpin). */
  unpinView(): void;
  /** The output just written, which may begin a synchronized update (SyncHold.wrote). */
  wroteOutput(data: string | Uint8Array): void;
  /**
   * Renders now, if the terminal is open and no synchronized update holds painting, so
   * typed input's echo shows without a frame's wait.
   */
  renderEcho(): void;
}

/** What the SyncHold reads and changes of the engine's mode 2026; nothing before open(). */
export interface SyncHoldHost {
  /** Whether mode 2026 is on. */
  active(): boolean;
  /** Turns mode 2026 off, as Ghostty does when an update runs past its time. */
  end(): void;
}

/** The steps of one render-loop frame, called in the order the RenderLoop fixes. */
export interface RenderLoopHost {
  /** Open and not disposed: the loop stops at the first frame where this is false. */
  live(): boolean;
  /** The embedder's callback (attachBeforeRender), so an animation shows in this frame. */
  beforeRender(now: number): void;
  stepFind(now: number): void;
  /** Whether this frame's paint waits for the app's synchronized update to end (SyncHold). */
  renderHeld(now: number): boolean;
  render(): void;
  /** Whether replies arose outside a write (a timer, a mode change) and wait for the PTY. */
  hasReplies(): boolean;
  drainReplies(): void;
  /** Keeps the input textarea on the cursor cell. */
  anchorTextarea(): void;
}

/**
 * The timeouts the mouse-move throttle runs on, injected so tests run them by hand;
 * production passes the browser's (`browserTimeouts` in mouse-controller.ts).
 */
export interface TimeoutScheduler {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

/** The engine calls the mouse makes: the row mapping, mouse tracking and the encoder (ADR 049). */
export type MouseEngine = Pick<
  GhosttyTerminal,
  'getScrollbackLength' | 'hasMouseTracking' | 'setMouseGeometry' | 'encodeMouse'
>;

/**
 * What the MouseController reads of the renderer: the cell size, how far row 0 sits below
 * the canvas top (ADR 043), and the hovered link's underline.
 */
export interface MouseRenderer {
  readonly charWidth: number;
  readonly charHeight: number;
  readonly scrollOffset: number;
  getMetrics(): { width: number; height: number };
  setHoveredLinkRange(range: ViewportLinkRange | null): void;
}

/** The link under a cell (LinkDetector), in absolute buffer rows. */
export interface LinkSource {
  getLinkAt(col: number, row: number): Promise<ILink | undefined>;
}

/** The selection calls a right-click makes (SelectionManager, ADR 051). */
export interface MenuSelection {
  getSelection(): string;
  copySelection(): boolean;
  clearSelection(): void;
  /** Readies the textarea under the pointer so the browser menu offers Copy. */
  prepareContextMenu(e: MouseEvent): void;
}

/**
 * What the MouseController reads of the terminal, each call made when an event arrives:
 * the parts open() creates (undefined before it and after dispose()), the grid and view,
 * the device cell size, the right-click option, the scrollbar drag that takes a move
 * first, and where a right-click paste goes (onPasteRequest).
 */
export interface MouseHost {
  element(): HTMLElement | undefined;
  canvas(): HTMLCanvasElement | undefined;
  engine(): MouseEngine | undefined;
  renderer(): MouseRenderer | undefined;
  links(): LinkSource | undefined;
  selection(): MenuSelection | undefined;
  rows(): number;
  cols(): number;
  viewportY(): number;
  /** The renderer's cell in whole device pixels, or null before open() (ADR 042). */
  cellPixelSize(): { width: number; height: number } | null;
  rightClickBehavior(): RightClickBehavior;
  /** Moves a scrollbar drag in progress; true when there was one and the move is used up. */
  dragScrollbar(e: MouseEvent): boolean;
  requestPaste(): void;
}

/** The engine calls wheel routing makes: mouse tracking, the screen, and DECCKM. */
export type WheelEngine = Pick<
  GhosttyTerminal,
  'hasMouseTracking' | 'isAlternateScreen' | 'getMode'
>;

/**
 * What the WheelController reads of the terminal when a wheel event arrives: the engine,
 * the cell height (undefined before open()), whether the canvas exists, the grid's rows,
 * the scroll speed option, the mouse encoder, and where ticks and arrows go (onData).
 */
export interface WheelHost {
  engine(): WheelEngine | undefined;
  cellHeight(): number | undefined;
  hasCanvas(): boolean;
  rows(): number;
  mouseScrollSpeed(): number;
  /** A mouse report at a client position, or '' (MouseController.encode). */
  encodeMouse(event: MouseEventReport): string;
  send(data: string): void;
}

/**
 * The clock the scrollbar's auto-hide and fade run on, injected so tests run them by hand;
 * production passes the browser's (`browserScrollbarClock` in scrollbar-controller.ts).
 */
export interface ScrollbarClock extends TimeoutScheduler {
  /** Wall-clock milliseconds, as `Date.now()`. */
  now(): number;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(id: number): void;
}

/**
 * What the ScrollbarController reads of the terminal when a press, drag or scroll arrives:
 * the canvas and how far row 0 sits below its top (both undefined before open() and after
 * dispose()), the scrollback and view it moves, and the frame that shows a new opacity.
 */
export interface ScrollbarHost {
  canvas(): HTMLCanvasElement | undefined;
  /** The renderer's scroll offset (ADR 043), or undefined without a renderer. */
  scrollOffset(): number | undefined;
  getScrollbackLength(): number;
  rows(): number;
  viewportY(): number;
  scrollToLine(line: number): void;
  /** Renders a frame with the scrollbar at `opacity`, if the terminal is open. */
  render(opacity: number): void;
}
