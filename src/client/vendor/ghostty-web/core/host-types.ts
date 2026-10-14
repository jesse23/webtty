// webtty (ADR 061), not from upstream.
// What Terminal's collaborators see of it (types): narrow interfaces instead of the
// Terminal, CanvasRenderer and engine classes, so a split part never imports a facade and
// no import cycle forms (ADR 061).

import type {
  DesktopNotification,
  GhosttyTerminal,
  SearchState,
} from '../engine/engine-types';
import type { SearchHighlights } from '../search';

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
  viewportY(): number;
  /** Whether the view is kept on a selected find match (FindController.anchored). */
  findAnchored(): boolean;
  scrollToBottom(): void;
  /** Renders now, if the terminal is open, so typed input's echo shows without a frame's wait. */
  renderEcho(): void;
}

/** The steps of one render-loop frame, called in the order the RenderLoop fixes. */
export interface RenderLoopHost {
  /** Open and not disposed: the loop stops at the first frame where this is false. */
  live(): boolean;
  /** The embedder's callback (attachBeforeRender), so an animation shows in this frame. */
  beforeRender(now: number): void;
  stepFind(now: number): void;
  render(): void;
  /** Whether replies arose outside a write (a timer, a mode change) and wait for the PTY. */
  hasReplies(): boolean;
  drainReplies(): void;
  /** Keeps the input textarea on the cursor cell. */
  anchorTextarea(): void;
}
