/**
 * Terminal - Main terminal emulator class
 *
 * Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.
 *
 * Usage:
 * ```typescript
 * import { init, Terminal } from 'ghostty-web';
 *
 * await init();
 * const term = new Terminal();
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { BufferNamespace } from './buffer';
import { EventEmitter } from './event-emitter';
import type { Ghostty, GhosttyCell, GhosttyTerminal, GhosttyTerminalConfig } from './ghostty';
import { getGhostty } from './index';
import { InputHandler, type MouseTrackingConfig } from './input-handler';
import type {
  IBufferNamespace,
  IBufferRange,
  IDisposable,
  IEvent,
  IKeyEvent,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
  IUnicodeVersionProvider,
} from './interfaces';
import { LinkDetector } from './link-detector';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { CanvasRenderer } from './renderer';
import { SelectionManager } from './selection-manager';
import type { ILink, ILinkProvider } from './types';

// ============================================================================
// Terminal Class
// ============================================================================

/**
 * Mouse cursor for the terminal surface: 'pointer' over a link, otherwise the
 * platform default arrow. (webtty: upstream used the 'text' I-beam, which reads
 * as editable text over TUI menus and widgets.)
 */
export function mouseCursorFor(link: ILink | undefined): 'pointer' | 'default' {
  return link ? 'pointer' : 'default';
}

/** Cursor shape set by an app through DECSCUSR. */
export interface CursorShape {
  style: 'block' | 'underline' | 'bar';
  blink: boolean;
}

// DECSCUSR is CSI Ps SP q. A sequence split across writes leaves a prefix at the
// end of a chunk, which is carried into the next scan.
const DECSCUSR = /\x1b\[(\d*) q/g;
const DECSCUSR_PREFIX = /\x1b(?:\[\d{0,3} ?)?$/;

/**
 * Scans output for DECSCUSR and returns the last Ps from 0 to 6 (undefined if
 * none), plus the unfinished sequence at the end of the chunk to pass back in as
 * `carry` with the next one. (webtty: the Coder wasm applies DECSCUSR but does not
 * export the cursor style, so it is read from the output here.)
 */
export function scanDecscusr(
  data: string,
  carry: string = ''
): { ps: number | undefined; carry: string } {
  const text = carry + data;
  let ps: number | undefined;
  for (const match of text.matchAll(DECSCUSR)) {
    const value = match[1] === '' ? 0 : Number(match[1]);
    if (value <= 6) ps = value;
  }
  return { ps, carry: DECSCUSR_PREFIX.exec(text)?.[0] ?? '' };
}

/**
 * Applies DECSCUSR Ps to the app's cursor shape: 1-6 set it, 0 clears it so the
 * configured `cursorStyle` / `cursorBlink` show again.
 */
export function decscusrShape(ps: number): CursorShape | undefined {
  if (ps === 0) return undefined;
  return {
    style: ps <= 2 ? 'block' : ps <= 4 ? 'underline' : 'bar',
    blink: ps % 2 === 1,
  };
}

/**
 * A cell's size in whole device pixels, for the official engine's size reports
 * (XTWINOPS 14/16/18/19 t, mode 2048). Computed as kitty.ts's `deviceCellSize`
 * does for its own replies: the CSS cell times `devicePixelRatio`, rounded, at
 * least 1. (webtty, ADR 042)
 */
export function deviceCellPixels(cssCell: number, dpr: number): number {
  return Math.max(1, Math.round(cssCell * dpr));
}

/** Wheel travel not yet sent to a mouse-tracking app, and its direction. */
export interface WheelAccumulator {
  accum: number;
  dir: number;
}

/**
 * Scroll ticks a wheel event sends to an app that tracks the mouse: negative
 * scrolls up (SGR button 64), positive down (65). Pixel deltas (trackpads, and
 * mouse wheels in Chromium/Safari on macOS) count by distance, one tick per cell
 * height, 1:1 with the OS, and `speed` does not apply (Ghostty skips its scroll
 * multiplier for precision scrolls too). Line and page deltas count one tick per
 * event times `speed`; below 1 the remainder accumulates. A direction change
 * drops the remainder. (webtty: upstream sent arrow keys on the alternate screen
 * and one SGR per event elsewhere, so trackpads scrolled far ahead of the fingers.)
 */
export function wheelTicks(
  acc: WheelAccumulator,
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  speed: number
): number {
  const dir = e.deltaY < 0 ? -1 : 1;
  if (dir !== acc.dir) {
    acc.accum = 0;
    acc.dir = dir;
  }
  // 0 is WheelEvent.DOM_DELTA_PIXEL.
  acc.accum += e.deltaMode === 0 ? Math.abs(e.deltaY) / cellHeight : speed;
  const ticks = Math.trunc(acc.accum);
  acc.accum -= ticks;
  return ticks === 0 ? 0 : ticks * dir;
}

/**
 * Arrow keys a wheel event sends on the alternate screen when the app does not
 * track the mouse: one per line of travel, like scrolling the normal screen's
 * scrollback. Pixel deltas count by cell height, line deltas by line, page deltas
 * by `rows`; the remainder accumulates and a direction change drops it. Negative
 * is up. (webtty: upstream sent round(deltaY / 33) per event, at most 5, so slow
 * trackpad deltas and Firefox's 3-line notches sent nothing; ADR 045)
 */
export function wheelArrows(
  acc: WheelAccumulator,
  e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>,
  cellHeight: number,
  rows: number
): number {
  const dir = e.deltaY < 0 ? -1 : 1;
  if (dir !== acc.dir) {
    acc.accum = 0;
    acc.dir = dir;
  }
  const amount = Math.abs(e.deltaY);
  // 0 is WheelEvent.DOM_DELTA_PIXEL, 1 DOM_DELTA_LINE.
  acc.accum += e.deltaMode === 0 ? amount / cellHeight : e.deltaMode === 1 ? amount : amount * rows;
  const lines = Math.trunc(acc.accum);
  acc.accum -= lines;
  return lines === 0 ? 0 : lines * dir;
}

/** One frame at 60 Hz. */
const FRAME_MS = 1000 / 60;

/**
 * How to send a wheel event's ticks: spread evenly over `duration` ms (0: at
 * once), or, with `omega`, following a critically damped spring of that stiffness
 * (rad/s) toward the queued total. (webtty, ADR 045)
 */
export interface WheelPace {
  duration: number;
  omega?: number;
}

/**
 * A spring's stiffness doubles once no wheel event has come for this long: the
 * stream has stopped, so the view should stop soon rather than coast for many
 * lines, while a running stream keeps the softer, steadier spring. (webtty, ADR 045)
 */
export const SPRING_RELEASE_MS = 60;

/** The stiffness of a spring with stiffness `omega` `sinceEvent` ms after the latest wheel event. */
export function springOmega(omega: number, sinceEvent: number): number {
  return sinceEvent > SPRING_RELEASE_MS ? omega * 2 : omega;
}

/**
 * Advances a critically damped spring at `x` with velocity `v` (per second)
 * toward a fixed `target` by `dt` seconds. Exact for a fixed target, so it is
 * stable at any frame time, and it never overshoots a target it approaches from
 * rest. Returns the new position and velocity. (webtty, ADR 045)
 */
export function springStep(
  x: number,
  v: number,
  target: number,
  omega: number,
  dt: number
): [number, number] {
  const e = x - target;
  const k = Math.exp(-omega * dt);
  const c = v + omega * e;
  return [target + (e + c * dt) * k, (v - omega * c * dt) * k];
}

/**
 * Sends the scroll ticks of wheel events to an app spread over time instead of in
 * one burst: a TrackPoint sends a delta of up to 20 lines every 30-200 ms, which
 * an app would otherwise scroll in jumps. Ticks queued with a duration go out
 * evenly over it, a few per frame; a new event's ticks join the ones still queued
 * and spread over its duration, starting from the latest frame so the pace does
 * not stall. A direction change drops the queued ticks, as `wheelTicks` drops its
 * remainder. (webtty, ADR 045)
 */
export class TickPacer {
  private seq = '';
  private dir = 0;
  private total = 0;
  private sent = 0;
  private start = 0;
  private duration = 0;
  /** Spring stiffness while following a fast stream, else 0; and its position and velocity in ticks. */
  private omega = 0;
  private x = 0;
  private v = 0;
  private lastPush = 0;
  private lastFrame: number | null = null;
  private frame = 0;

  constructor(private readonly send: (data: string) => void) {}

  /** Queues `count` ticks of `seq` in direction `dir` (-1 or 1) to send as `pace` says; a 0 duration sends them now. */
  push(seq: string, dir: number, count: number, pace: WheelPace): void {
    if (dir !== this.dir) this.cancel();
    this.dir = dir;
    // The latest event's sequence: its cell is where the pointer is now.
    this.seq = seq;
    this.lastPush = performance.now();
    const pending = this.total - this.sent;
    if (pace.omega) {
      if (!this.omega) {
        // Take over at the linear pace's speed, so the rate does not jump.
        const linear = this.frame && this.duration > 0 ? (this.total / this.duration) * 1000 : 0;
        this.total = pending;
        this.sent = 0;
        this.x = 0;
        this.v = linear;
      }
      this.omega = pace.omega;
      this.total += count;
    } else if (pace.duration <= 0) {
      this.stop();
      this.send(seq.repeat(pending + count));
      return;
    } else {
      this.omega = 0;
      this.total = pending + count;
      this.sent = 0;
      this.start = this.lastFrame ?? performance.now() - FRAME_MS;
      this.duration = pace.duration;
    }
    if (!this.frame) this.frame = requestAnimationFrame(this.step);
  }

  /** Drops the queued ticks. */
  cancel(): void {
    this.stop();
    this.dir = 0;
  }

  private stop(): void {
    this.total = 0;
    this.sent = 0;
    this.omega = 0;
    this.x = 0;
    this.v = 0;
    this.lastFrame = null;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private readonly step = (now: number): void => {
    this.frame = 0;
    let progress: number;
    if (this.omega) {
      const dt = Math.min(now - (this.lastFrame ?? now - FRAME_MS), 50) / 1000;
      const omega = springOmega(this.omega, now - this.lastPush);
      [this.x, this.v] = springStep(this.x, this.v, this.total, omega, dt);
      progress = Math.min(this.total, this.x);
    } else {
      const t = Math.min(1, Math.max(0, (now - this.start) / this.duration));
      progress = this.total * t;
    }
    // Rounded up, so the first tick goes out on the first frame: a 1-tick notch
    // is not held back for half the duration.
    const due = Math.min(this.total, Math.ceil(progress - 1e-9)) - this.sent;
    if (due > 0) {
      this.send(this.seq.repeat(due));
      this.sent += due;
    }
    if (this.sent < this.total) {
      this.lastFrame = now;
      this.frame = requestAnimationFrame(this.step);
    } else {
      this.stop();
    }
  };
}

/** SGR mouse report for `ticks` wheel ticks at a 1-based cell. */
export function wheelSgr(ticks: number, col: number, row: number): string {
  const btn = ticks < 0 ? 64 : 65;
  return `\x1b[<${btn};${col};${row}M`.repeat(Math.abs(ticks));
}

/**
 * The cursor cell's top-left corner, in CSS pixels relative to the container's
 * padding box. `cursor.y` is relative to the bottom screen; when scrolled back by
 * `viewportY` lines the cursor moves down by that many rows, and it is kept on the
 * last visible row once it scrolls out of view. A pending-wrap cursor is kept on
 * the last column. (webtty: the input textarea is anchored here so the OS places
 * IME and dictation panels at the cursor.)
 */
export function cursorCellOffset(
  cursor: { x: number; y: number },
  viewportY: number,
  grid: { cols: number; rows: number },
  cell: { width: number; height: number },
  canvas: { left: number; top: number }
): { left: number; top: number } {
  const col = Math.min(Math.max(0, cursor.x), Math.max(0, grid.cols - 1));
  const row = Math.min(Math.max(0, cursor.y + Math.floor(viewportY)), Math.max(0, grid.rows - 1));
  return {
    left: canvas.left + col * cell.width,
    top: canvas.top + row * cell.height,
  };
}

/** Sets a pixel style only when it changed, so a per-frame update writes nothing. */
function setStylePx(
  el: HTMLElement,
  prop: 'left' | 'top' | 'width' | 'height',
  value: number
): void {
  const px = `${value}px`;
  if (el.style[prop] !== px) el.style[prop] = px;
}

export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;

  // Unicode API (xterm.js compatibility)
  public readonly unicode: IUnicodeVersionProvider = {
    get activeVersion(): string {
      return '15.1'; // Ghostty supports Unicode 15.1
    },
  };

  // Options (public for xterm.js compatibility)
  public readonly options!: Required<ITerminalOptions>;

  // Components (created on open())
  private ghostty?: Ghostty;
  public wasmTerm?: GhosttyTerminal; // Made public for link providers
  public renderer?: CanvasRenderer; // Made public for FitAddon
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private canvas?: HTMLCanvasElement;

  // Link detection system
  private linkDetector?: LinkDetector;
  private currentHoveredLink?: ILink;
  private mouseMoveThrottleTimeout?: number;
  private pendingMouseMove?: MouseEvent;

  // Event emitters
  private dataEmitter = new EventEmitter<string>();
  private resizeEmitter = new EventEmitter<{ cols: number; rows: number }>();
  private bellEmitter = new EventEmitter<void>();
  private selectionChangeEmitter = new EventEmitter<void>();
  private keyEmitter = new EventEmitter<IKeyEvent>();
  private titleChangeEmitter = new EventEmitter<string>();
  private scrollEmitter = new EventEmitter<number>();
  private renderEmitter = new EventEmitter<{ start: number; end: number }>();
  private cursorMoveEmitter = new EventEmitter<void>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  public readonly onBell: IEvent<void> = this.bellEmitter.event;
  public readonly onSelectionChange: IEvent<void> = this.selectionChangeEmitter.event;
  public readonly onKey: IEvent<IKeyEvent> = this.keyEmitter.event;
  public readonly onTitleChange: IEvent<string> = this.titleChangeEmitter.event;
  public readonly onScroll: IEvent<number> = this.scrollEmitter.event;
  public readonly onRender: IEvent<{ start: number; end: number }> = this.renderEmitter.event;
  public readonly onCursorMove: IEvent<void> = this.cursorMoveEmitter.event;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private writeQueue: Uint8Array[] = [];
  private awaitingEcho = false;

  // Addons
  private addons: ITerminalAddon[] = [];

  // Phase 1: Custom event handlers
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;

  // Phase 1: Title tracking
  private currentTitle: string = '';

  // Phase 2: Viewport and scrolling state
  public viewportY: number = 0; // Top line of viewport in scrollback buffer (0 = at bottom, can be fractional during smooth scroll)
  private targetViewportY: number = 0; // Target viewport position for smooth scrolling
  private scrollAnimationStartTime?: number;
  private scrollAnimationStartY?: number;
  private scrollAnimationFrame?: number;
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  private wheelAccumulator: WheelAccumulator = { accum: 0, dir: 0 };
  private arrowAccumulator: WheelAccumulator = { accum: 0, dir: 0 };
  private customWheelTickSpread?: (event: WheelEvent) => WheelPace;
  private beforeRender?: (now: number) => void;
  private readonly tickPacer = new TickPacer((data) => this.dataEmitter.fire(data));
  private lastCursorY: number = 0; // Track cursor position for onCursorMove
  // DECSCUSR state: the app's cursor shape (undefined = options) and the
  // unfinished sequence at the end of the last write
  private appCursorShape?: CursorShape;
  private decscusrCarry: string = '';
  private readonly decoder = new TextDecoder();

  // Scrollbar interaction state
  private isDraggingScrollbar: boolean = false;
  private scrollbarDragStart: number | null = null;
  private scrollbarDragStartViewportY: number = 0;

  // Scrollbar visibility/auto-hide state
  private scrollbarVisible: boolean = false;
  private scrollbarOpacity: number = 0;
  private scrollbarHideTimeout?: number;
  private readonly SCROLLBAR_HIDE_DELAY_MS = 1500; // Hide after 1.5 seconds
  private readonly SCROLLBAR_FADE_DURATION_MS = 200; // 200ms fade animation

  constructor(options: ITerminalOptions = {}) {
    // Use provided Ghostty instance (for test isolation) or get module-level instance
    this.ghostty = options.ghostty ?? getGhostty();

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: options.theme ?? {},
      scrollback: options.scrollback ?? 10000,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      allowTransparency: options.allowTransparency ?? false,
      convertEol: options.convertEol ?? false,
      disableStdin: options.disableStdin ?? false,
      smoothScrollDuration: options.smoothScrollDuration ?? 100, // Default: 100ms smooth scroll
      mouseScrollSpeed: options.mouseScrollSpeed ?? 1,
    };

    // Wrap in Proxy to intercept runtime changes (xterm.js compatibility)
    (this.options as any) = new Proxy(baseOptions, {
      set: (target: any, prop: string, value: any) => {
        const oldValue = target[prop];
        target[prop] = value;

        // Apply runtime changes if terminal is open
        if (this.isOpen) {
          this.handleOptionChange(prop, value, oldValue);
        }

        return true;
      },
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
  }

  // ==========================================================================
  // Option Change Handling (for mutable options)
  // ==========================================================================

  /**
   * Handle runtime option changes (called when options are modified after terminal is open)
   * This enables xterm.js compatibility where options can be changed at runtime
   */
  private handleOptionChange(key: string, newValue: any, oldValue: any): void {
    if (newValue === oldValue) return;

    switch (key) {
      case 'disableStdin':
        // Input handler already checks this.options.disableStdin dynamically
        // No action needed
        break;

      case 'cursorBlink':
      case 'cursorStyle':
        this.applyCursorShape();
        break;

      case 'theme':
        if (this.renderer) {
          console.warn('ghostty-web: theme changes after open() are not yet fully supported');
        }
        break;

      case 'fontSize':
        if (this.renderer) {
          this.renderer.setFontSize(this.options.fontSize);
          this.handleFontChange();
        }
        break;

      case 'fontFamily':
        if (this.renderer) {
          this.renderer.setFontFamily(this.options.fontFamily);
          this.handleFontChange();
        }
        break;

      case 'cols':
      case 'rows':
        // Redirect to resize method
        this.resize(this.options.cols, this.options.rows);
        break;
    }
  }

  /**
   * Handle font changes (fontSize or fontFamily)
   * Updates canvas size to match new font metrics and forces a full re-render
   */
  private handleFontChange(): void {
    if (!this.renderer || !this.wasmTerm || !this.canvas) return;

    // Clear any active selection since pixel positions have changed
    if (this.selectionManager) {
      this.selectionManager.clearSelection();
    }

    // Resize canvas to match new font metrics
    this.renderer.resize(this.cols, this.rows);

    // Update canvas element dimensions to match renderer. The element draws nothing: the
    // renderer draws on a canvas of its own (webtty, ADR 043)
    const metrics = this.renderer.getMetrics();
    this.canvas.style.width = `${metrics.width * this.cols}px`;
    this.canvas.style.height = `${metrics.height * this.rows}px`;

    // Force full re-render with new font, the scrollbar at its current opacity: a frame
    // that drops it repaints every row (webtty, ADR 043)
    this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);
  }

  /**
   * Parse a CSS color string to 0xRRGGBB format, or undefined if the color is
   * undefined or invalid. (webtty: replaces `parseColorToHex`, which returned 0
   * for both; tells `#000000` apart from "not given", ADR 042)
   */
  private parseColor(color?: string): number | undefined {
    if (!color) return undefined;

    // Handle hex colors (#RGB, #RRGGBB)
    if (color.startsWith('#')) {
      let hex = color.slice(1);
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      const value = Number.parseInt(hex, 16);
      return Number.isNaN(value) ? undefined : value;
    }

    // Handle rgb(r, g, b) format
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (match) {
      const r = Number.parseInt(match[1], 10);
      const g = Number.parseInt(match[2], 10);
      const b = Number.parseInt(match[3], 10);
      return (r << 16) | (g << 8) | b;
    }

    return undefined;
  }

  /**
   * Convert terminal options to WASM terminal config.
   */
  private buildWasmConfig(): GhosttyTerminalConfig | undefined {
    const theme = this.options.theme;
    const scrollback = this.options.scrollback;

    // If no theme and default scrollback, use defaults
    if (!theme && scrollback === 10000) {
      return undefined;
    }

    // Build palette array from theme colors
    // Order: black, red, green, yellow, blue, magenta, cyan, white,
    //        brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite
    const paletteColors = [
      theme?.black,
      theme?.red,
      theme?.green,
      theme?.yellow,
      theme?.blue,
      theme?.magenta,
      theme?.cyan,
      theme?.white,
      theme?.brightBlack,
      theme?.brightRed,
      theme?.brightGreen,
      theme?.brightYellow,
      theme?.brightBlue,
      theme?.brightMagenta,
      theme?.brightCyan,
      theme?.brightWhite,
    ].map((color) => this.parseColor(color));
    const fg = this.parseColor(theme?.foreground);
    const bg = this.parseColor(theme?.background);
    const cursor = this.parseColor(theme?.cursor);

    return {
      scrollbackLimit: scrollback,
      fgColor: fg ?? 0,
      bgColor: bg ?? 0,
      cursorColor: cursor ?? 0,
      palette: paletteColors.map((color) => color ?? 0),
      // Which colours parsed, so the official engine sets #000000 as black instead
      // of reading 0 as "use default". The Coder engine ignores it. (webtty, ADR 042)
      colorsSet: {
        foreground: fg !== undefined,
        background: bg !== undefined,
        cursor: cursor !== undefined,
        palette: paletteColors.map((color) => color !== undefined),
      },
    };
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Open terminal in a parent element
   *
   * Initializes all components and starts rendering.
   * Requires a pre-loaded Ghostty instance passed to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) {
      throw new Error('Terminal is already open');
    }
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }

    // Store parent element
    this.element = parent;
    this.isOpen = true;

    try {
      // Make parent focusable if it isn't already
      if (!parent.hasAttribute('tabindex')) {
        parent.setAttribute('tabindex', '0');
      }

      // Mark as contenteditable so browser extensions (Vimium, etc.) recognize
      // this as an input element and don't intercept keyboard events.
      parent.setAttribute('contenteditable', 'true');
      // Prevent actual content editing - we handle input ourselves
      parent.addEventListener('beforeinput', (e) => {
        if (e.target === parent) {
          e.preventDefault();
        }
      });
      // Never let the container hold focus, or the browser writes IME composition
      // text into it; input goes to the textarea. This covers clicks in the padding,
      // tab focus and focus(). (webtty)
      parent.addEventListener('focusin', this.handleFocusIn);
      // focus() on a background window moves activeElement without a focusin; catch
      // the container still holding focus when the window comes back. (webtty)
      window.addEventListener('focus', this.handleWindowFocus);

      // Add accessibility attributes for screen readers and extensions
      parent.setAttribute('role', 'textbox');
      parent.setAttribute('aria-label', 'Terminal input');
      parent.setAttribute('aria-multiline', 'true');

      // Create WASM terminal with current dimensions and config
      const config = this.buildWasmConfig();
      this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);

      // Create canvas element
      this.canvas = document.createElement('canvas');
      this.canvas.style.display = 'block';
      this.canvas.style.cursor = mouseCursorFor(undefined);

      parent.appendChild(this.canvas);

      // Create hidden textarea for keyboard input (must be inside parent for event bubbling)
      this.textarea = document.createElement('textarea');
      this.textarea.setAttribute('autocorrect', 'off');
      this.textarea.setAttribute('autocapitalize', 'off');
      this.textarea.setAttribute('spellcheck', 'false');
      this.textarea.setAttribute('tabindex', '0'); // Allow focus for mobile keyboard
      this.textarea.setAttribute('aria-label', 'Terminal input');
      // Use clip-path to completely hide the textarea and its caret
      this.textarea.style.position = 'absolute';
      this.textarea.style.left = '0';
      this.textarea.style.top = '0';
      this.textarea.style.width = '1px';
      this.textarea.style.height = '1px';
      this.textarea.style.padding = '0';
      this.textarea.style.border = 'none';
      this.textarea.style.margin = '0';
      this.textarea.style.opacity = '0';
      this.textarea.style.clipPath = 'inset(50%)'; // Clip everything including caret
      this.textarea.style.overflow = 'hidden';
      this.textarea.style.whiteSpace = 'nowrap';
      this.textarea.style.resize = 'none';
      parent.appendChild(this.textarea);

      // Focus textarea on interaction - preventDefault before focus
      const textarea = this.textarea;
      // Desktop: mousedown
      this.canvas.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });
      // Mobile: touchend with preventDefault to suppress iOS caret
      this.canvas.addEventListener('touchend', (ev) => {
        ev.preventDefault();
        textarea.focus();
      });

      // Create renderer
      this.renderer = new CanvasRenderer(this.canvas, {
        fontSize: this.options.fontSize,
        fontFamily: this.options.fontFamily,
        cursorStyle: this.options.cursorStyle,
        cursorBlink: this.options.cursorBlink,
        theme: this.options.theme,
      });

      // Size canvas to terminal dimensions (use renderer.resize for proper DPI scaling)
      this.renderer.resize(this.cols, this.rows);

      // Cell pixels for the official engine's size reports, before the first write,
      // so a reply never says 0 px. Mode 2048 cannot be on yet. (webtty, ADR 042)
      this.syncCellPixelSize();

      // Create mouse tracking configuration
      const canvas = this.canvas;
      const renderer = this.renderer;
      const wasmTerm = this.wasmTerm;
      const mouseConfig: MouseTrackingConfig = {
        hasMouseTracking: () => wasmTerm?.hasMouseTracking() ?? false,
        hasSgrMouseMode: () => wasmTerm?.getMode(1006, false) ?? true, // SGR extended mode
        getCellDimensions: () => ({
          width: renderer.charWidth,
          height: renderer.charHeight,
        }),
        getCanvasOffset: () => {
          const rect = canvas.getBoundingClientRect();
          // Viewport row 0 starts the scroll offset below the canvas top (webtty, ADR 043)
          return { left: rect.left, top: rect.top + renderer.scrollOffset };
        },
      };

      // Create input handler
      this.inputHandler = new InputHandler(
        this.ghostty!,
        parent,
        (data: string) => {
          // Check if stdin is disabled
          if (this.options.disableStdin) {
            return;
          }
          // Clear selection when user types
          this.selectionManager?.clearSelection();
          this.awaitingEcho = true;
          // Input handler fires data events
          this.dataEmitter.fire(data);
        },
        () => {
          // Input handler can also fire bell
          this.bellEmitter.fire();
        },
        (keyEvent: IKeyEvent) => {
          // Forward key events
          this.keyEmitter.fire(keyEvent);
        },
        this.customKeyEventHandler,
        (mode: number) => {
          // Query terminal mode state (e.g., mode 1 for application cursor mode)
          return this.wasmTerm?.getMode(mode, false) ?? false;
        },
        () => {
          // Handle Cmd+C copy - returns true if there was a selection to copy
          return this.copySelection();
        },
        this.textarea,
        mouseConfig
      );

      // Create selection manager (pass textarea for context menu positioning)
      this.selectionManager = new SelectionManager(
        this,
        this.renderer,
        this.wasmTerm,
        this.textarea
      );

      // Connect selection manager to renderer
      this.renderer.setSelectionManager(this.selectionManager);

      // Forward selection change events
      this.selectionManager.onSelectionChange(() => {
        this.selectionChangeEmitter.fire();
      });

      // Initialize link detection system
      this.linkDetector = new LinkDetector(this);

      // Register link providers
      // OSC8 first (explicit hyperlinks take precedence)
      this.linkDetector.registerProvider(new OSC8LinkProvider(this));
      // URL regex second (fallback for plain text URLs)
      this.linkDetector.registerProvider(new UrlRegexProvider(this));

      // Setup mouse event handling for links and scrollbar
      // Use capture phase to intercept scrollbar clicks before SelectionManager
      parent.addEventListener('mousedown', this.handleMouseDown, { capture: true });
      parent.addEventListener('mousemove', this.handleMouseMove);
      parent.addEventListener('mouseleave', this.handleMouseLeave);
      parent.addEventListener('click', this.handleClick);

      // Setup document-level mouseup for scrollbar drag (so drag works even outside canvas)
      document.addEventListener('mouseup', this.handleMouseUp);

      // Setup wheel event handling for scrolling (Phase 2)
      // Use capture phase to ensure we get the event before browser scrolling
      parent.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });

      // Render initial blank screen (force full redraw)
      this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);

      // Start render loop
      this.startRenderLoop();

      // Focus input (auto-focus so user can start typing immediately)
      this.focus();
    } catch (error) {
      // Clean up on error
      this.isOpen = false;
      this.cleanupComponents();
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * Write data to terminal
   */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.assertOpen();

    // Handle convertEol option
    if (this.options.convertEol && typeof data === 'string') {
      data = data.replace(/\n/g, '\r\n');
    }

    this.writeInternal(data, callback);
  }

  /**
   * Internal write implementation (extracted from write())
   */
  private writeInternal(data: string | Uint8Array, callback?: () => void): void {
    // Note: We intentionally do NOT clear selection on write - most modern terminals
    // preserve selection when new data arrives. Selection is cleared by user actions
    // like clicking or typing, not by incoming data.

    // Write directly to WASM terminal (handles VT parsing internally)
    this.wasmTerm!.write(data);

    // Process any responses generated by the terminal (e.g., DSR cursor position)
    // These need to be sent back to the PTY via onData
    this.processTerminalResponses();

    // Check for bell character (BEL, \x07)
    // The Coder wasm doesn't expose bell events, so we detect it in the data stream.
    // The official engine reports bell and title itself. (webtty, ADR 042)
    const scanStream = this.ghostty?.engine !== 'official';
    if (!scanStream) {
      const effects = this.wasmTerm!.readEffects();
      if (effects.bell) this.bellEmitter.fire();
      if (effects.title !== null) this.setTitle(effects.title);
    } else if (typeof data === 'string' && data.includes('\x07')) {
      this.bellEmitter.fire();
    } else if (data instanceof Uint8Array && data.includes(0x07)) {
      this.bellEmitter.fire();
    }

    // DECSCUSR: the app's cursor shape (webtty)
    const decscusr = scanDecscusr(
      typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }),
      this.decscusrCarry
    );
    this.decscusrCarry = decscusr.carry;
    if (decscusr.ps !== undefined) {
      this.appCursorShape = decscusrShape(decscusr.ps);
      this.applyCursorShape();
    }

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    // Phase 2: Auto-scroll to bottom on new output (xterm.js behavior)
    if (this.viewportY !== 0) {
      this.scrollToBottom();
    }

    // Check for title changes (OSC 0, 1, 2 sequences)
    // This is a simplified implementation - Ghostty WASM may provide this
    if (scanStream && typeof data === 'string' && data.includes('\x1b]')) {
      this.checkForTitleChange(data);
    }

    // Call callback if provided
    if (callback) {
      // Queue callback after next render
      requestAnimationFrame(callback);
    }

    if (this.awaitingEcho) {
      this.awaitingEcho = false;
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }
    }

    // Render will happen on next animation frame
  }

  /**
   * Write data with newline
   */
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (typeof data === 'string') {
      this.write(data + '\r\n', callback);
    } else {
      // Append \r\n to Uint8Array
      const newData = new Uint8Array(data.length + 2);
      newData.set(data);
      newData[data.length] = 0x0d; // \r
      newData[data.length + 1] = 0x0a; // \n
      this.write(newData, callback);
    }
  }

  /**
   * Paste text into terminal (triggers bracketed paste if supported)
   */
  paste(data: string): void {
    this.assertOpen();

    // Don't paste if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    this.awaitingEcho = true;

    // Check if terminal has bracketed paste mode enabled
    if (this.wasmTerm!.hasBracketedPaste()) {
      // Wrap with bracketed paste sequences (DEC mode 2004)
      this.dataEmitter.fire('\x1b[200~' + data + '\x1b[201~');
    } else {
      // Send data directly
      this.dataEmitter.fire(data);
    }
  }

  /**
   * Input data into terminal (as if typed by user)
   *
   * @param data - Data to input
   * @param wasUserInput - If true, triggers onData event (default: false for compat with some apps)
   */
  input(data: string, wasUserInput: boolean = false): void {
    this.assertOpen();

    // Don't input if stdin is disabled
    if (this.options.disableStdin) {
      return;
    }

    if (wasUserInput) {
      this.awaitingEcho = true;
      // Trigger onData event as if user typed it
      this.dataEmitter.fire(data);
    } else {
      // Just write to terminal without triggering onData
      this.write(data);
    }
  }

  /**
   * Resize terminal
   */
  resize(cols: number, rows: number): void {
    this.assertOpen();

    if (cols === this.cols && rows === this.rows) {
      return; // No change
    }

    // Cancel render loop before resize to prevent accessing detached TypedArray
    // views while WASM reallocates buffers. We restart it after resize completes.
    // This avoids the background-tab regression of using an isResizing flag
    // cleared via requestAnimationFrame (rAF is throttled/paused in background tabs).
    this.cancelRenderLoop();

    try {
      // Update dimensions
      this.cols = cols;
      this.rows = rows;

      // Resize WASM terminal (may reallocate buffers, invalidating TypedArray views).
      // The official engine takes the device-pixel cell size in the same call, so a
      // change of grid and pixels is one size report. (webtty, ADR 042)
      const px = this.cellPixelSize();
      this.wasmTerm!.resize(cols, rows, px?.width, px?.height);

      // Resize renderer
      this.renderer!.resize(cols, rows);

      // Update canvas dimensions. The element draws nothing: the renderer draws on a
      // canvas of its own (webtty, ADR 043)
      const metrics = this.renderer!.getMetrics();
      this.canvas!.style.width = `${metrics.width * cols}px`;
      this.canvas!.style.height = `${metrics.height * rows}px`;

      // Fire resize event
      this.resizeEmitter.fire({ cols, rows });

      // A mode 2048 size report from the resize, sent after the PTY resize message
      // (webtty, ADR 042)
      this.processTerminalResponses();

      // Force full render, the scrollbar at its current opacity (webtty, ADR 043)
      this.renderer!.render(this.wasmTerm!, true, this.viewportY, this, this.scrollbarOpacity);
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }

    // Flush any writes that were queued during resize, then restart render loop
    this.flushWriteQueue();
    this.startRenderLoop();
  }

  /**
   * Sends the current device-pixel cell size to the engine for its size reports.
   * Called at the end of every fit: if the grid changed, resize() has already sent
   * it and this does nothing; if only the pixels changed (font zoom or load, DPR),
   * the official engine makes one size update. A no-op on the Coder engine.
   * (webtty, ADR 042)
   */
  syncCellPixelSize(): void {
    const px = this.cellPixelSize();
    if (!this.wasmTerm || !px) return;
    this.wasmTerm.setCellPixelSize(px.width, px.height);
    this.processTerminalResponses();
  }

  /** The renderer's cell in whole device pixels, or null before open(). (webtty) */
  private cellPixelSize(): { width: number; height: number } | null {
    if (!this.renderer) return null;
    const metrics = this.renderer.getMetrics();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return {
      width: deviceCellPixels(metrics.width, dpr),
      height: deviceCellPixels(metrics.height, dpr),
    };
  }

  /**
   * Clear terminal screen
   */
  clear(): void {
    this.assertOpen();
    // Send ANSI clear screen and cursor home sequences
    this.wasmTerm!.write('\x1b[2J\x1b[H');
  }

  /**
   * Reset terminal state
   */
  reset(): void {
    this.assertOpen();

    // Free old WASM terminal and create new one
    if (this.wasmTerm) {
      this.wasmTerm.free();
    }
    const config = this.buildWasmConfig();
    this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
    this.syncCellPixelSize();

    // Clear renderer
    this.renderer!.clear();

    // Reset title
    this.currentTitle = '';

    // Back to the configured cursor shape (webtty)
    this.appCursorShape = undefined;
    this.decscusrCarry = '';
    this.applyCursorShape();
  }

  /**
   * Shows the app's DECSCUSR cursor shape, or the configured one when the app has
   * not set one. The renderer repaints the cursor cell when the shape changes.
   * (webtty)
   */
  private applyCursorShape(): void {
    if (!this.renderer) return;
    this.renderer.setCursorStyle(this.appCursorShape?.style ?? this.options.cursorStyle);
    this.renderer.setCursorBlink(this.appCursorShape?.blink ?? this.options.cursorBlink);
  }

  /**
   * Focus terminal input
   */
  focus(): void {
    if (this.isOpen && this.element) {
      // Focus immediately for immediate keyboard/wheel event handling
      this.element.focus();

      // Also schedule a delayed focus as backup to ensure it sticks
      // (some browsers may need this if DOM isn't fully settled)
      setTimeout(() => {
        this.element?.focus();
      }, 0);
    }
  }

  /**
   * Blur terminal (remove focus)
   */
  blur(): void {
    if (this.isOpen && this.element) {
      this.element.blur();
    }
  }

  /**
   * Load an addon
   */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  // ==========================================================================
  // Selection API (xterm.js compatible)
  // ==========================================================================

  /**
   * Get the selected text as a string
   */
  public getSelection(): string {
    return this.selectionManager?.getSelection() || '';
  }

  /**
   * Check if there's an active selection
   */
  public hasSelection(): boolean {
    return this.selectionManager?.hasSelection() || false;
  }

  /**
   * Clear the current selection
   */
  public clearSelection(): void {
    this.selectionManager?.clearSelection();
  }

  /**
   * Copy the current selection to clipboard
   * @returns true if there was text to copy, false otherwise
   */
  public copySelection(): boolean {
    return this.selectionManager?.copySelection() || false;
  }

  /**
   * Select all text in the terminal
   */
  public selectAll(): void {
    this.selectionManager?.selectAll();
  }

  /**
   * Select text at specific column and row with length
   */
  public select(column: number, row: number, length: number): void {
    this.selectionManager?.select(column, row, length);
  }

  /**
   * Select entire lines from start to end
   */
  public selectLines(start: number, end: number): void {
    this.selectionManager?.selectLines(start, end);
  }

  /**
   * Get selection position as buffer range
   */
  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  public getSelectionPosition(): IBufferRange | undefined {
    return this.selectionManager?.getSelectionPosition();
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

  /**
   * Attach a custom keyboard event handler
   * Returns true to prevent default handling
   */
  public attachCustomKeyEventHandler(
    customKeyEventHandler: (event: KeyboardEvent) => boolean
  ): void {
    this.customKeyEventHandler = customKeyEventHandler;
    // Update input handler if already created
    if (this.inputHandler) {
      this.inputHandler.setCustomKeyEventHandler(customKeyEventHandler);
    }
  }

  /**
   * Attach a custom wheel event handler (Phase 2)
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.customWheelEventHandler = customWheelEventHandler;
  }

  /**
   * Sets how to pace the scroll ticks of a wheel event sent to the app (mouse
   * tracking, or arrow keys on the alternate screen); a 0 duration sends them at
   * once, as without a handler. Called once per such event. (webtty, ADR 045)
   */
  public attachWheelTickSpread(spread?: (event: WheelEvent) => WheelPace): void {
    this.customWheelTickSpread = spread;
  }

  /**
   * Runs `callback` in every frame of the render loop, just before it renders, so
   * an animation that moves the viewport shows in the same frame. (webtty, ADR 045)
   */
  public attachBeforeRender(callback?: (now: number) => void): void {
    this.beforeRender = callback;
  }

  // ==========================================================================
  // Link Detection Methods
  // ==========================================================================

  /**
   * Register a custom link provider
   * Multiple providers can be registered to detect different types of links
   *
   * @example
   * ```typescript
   * term.registerLinkProvider({
   *   provideLinks(y, callback) {
   *     // Detect URLs, file paths, etc.
   *     callback(detectedLinks);
   *   }
   * });
   * ```
   */
  public registerLinkProvider(provider: ILinkProvider): void {
    if (!this.linkDetector) {
      throw new Error('Terminal must be opened before registering link providers');
    }
    this.linkDetector.registerProvider(provider);
  }

  // ==========================================================================
  // Phase 2: Scrolling Methods
  // ==========================================================================

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Calculate new viewport position
    // viewportY = 0 means at bottom (no scroll)
    // viewportY > 0 means scrolled up into history
    // amount < 0 (scroll up) should INCREASE viewportY
    // amount > 0 (scroll down) should DECREASE viewportY
    // So we SUBTRACT amount (negative amount becomes positive change)
    const newViewportY = Math.max(0, Math.min(maxScroll, this.viewportY - amount));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;
      this.scrollEmitter.fire(this.viewportY);

      // Show scrollbar when scrolling (with auto-hide)
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
    }
  }

  /**
   * Scroll viewport by a number of pages
   * @param amount Number of pages to scroll (positive = down, negative = up)
   */
  public scrollPages(amount: number): void {
    this.scrollLines(amount * this.rows);
  }

  /**
   * Scroll viewport to the top of the scrollback buffer
   */
  public scrollToTop(): void {
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0 && this.viewportY !== scrollbackLength) {
      this.viewportY = scrollbackLength;
      this.scrollEmitter.fire(this.viewportY);
      this.showScrollbar();
    }
  }

  /**
   * Scroll viewport to the bottom (current output)
   */
  public scrollToBottom(): void {
    if (this.viewportY !== 0) {
      this.viewportY = 0;
      this.scrollEmitter.fire(this.viewportY);
      // Show scrollbar briefly when scrolling to bottom
      if (this.getScrollbackLength() > 0) {
        this.showScrollbar();
      }
    }
  }

  /**
   * Scroll viewport to a specific line in the buffer
   * @param line Line number (0 = top of scrollback, scrollbackLength = bottom)
   */
  public scrollToLine(line: number): void {
    const scrollbackLength = this.getScrollbackLength();
    const newViewportY = Math.max(0, Math.min(scrollbackLength, line));

    if (newViewportY !== this.viewportY) {
      this.viewportY = newViewportY;
      this.scrollEmitter.fire(this.viewportY);

      // Show scrollbar when scrolling to specific line
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
    }
  }

  /**
   * Smoothly scroll to a target viewport position
   * @param targetY Target viewport Y position (in lines, can be fractional)
   */
  private smoothScrollTo(targetY: number): void {
    if (!this.wasmTerm) return;

    const scrollbackLength = this.getScrollbackLength();
    const maxScroll = scrollbackLength;

    // Clamp target to valid range
    const newTarget = Math.max(0, Math.min(maxScroll, targetY));

    // If smooth scrolling is disabled (duration = 0), jump immediately
    const duration = this.options.smoothScrollDuration ?? 100;
    if (duration === 0) {
      this.viewportY = newTarget;
      this.targetViewportY = newTarget;
      this.scrollEmitter.fire(Math.floor(this.viewportY));

      if (scrollbackLength > 0) {
        this.showScrollbar();
      }
      return;
    }

    // Update target (accumulate if animation running)
    this.targetViewportY = newTarget;

    // If animation is already running, don't restart it
    // Just let it continue toward the updated target
    // This prevents choppy restarts during continuous scrolling
    if (this.scrollAnimationFrame) {
      return;
    }

    // Start new animation
    this.scrollAnimationStartTime = Date.now();
    this.scrollAnimationStartY = this.viewportY;
    this.animateScroll();
  }

  /**
   * Animation loop for smooth scrolling
   * Uses asymptotic approach - moves a fraction of remaining distance each frame
   */
  private animateScroll = (): void => {
    if (!this.wasmTerm || this.scrollAnimationStartTime === undefined) {
      return;
    }

    const duration = this.options.smoothScrollDuration ?? 100;

    // Calculate distance to target
    const distance = this.targetViewportY - this.viewportY;
    const absDistance = Math.abs(distance);

    // If very close, snap to target
    if (absDistance < 0.01) {
      this.viewportY = this.targetViewportY;
      this.scrollEmitter.fire(Math.floor(this.viewportY));

      const scrollbackLength = this.getScrollbackLength();
      if (scrollbackLength > 0) {
        this.showScrollbar();
      }

      // Animation complete
      this.scrollAnimationFrame = undefined;
      this.scrollAnimationStartTime = undefined;
      this.scrollAnimationStartY = undefined;
      return;
    }

    // Move a fraction of the remaining distance
    // At 60fps, move ~1/6 of distance per frame for ~100ms total duration
    // This creates smooth deceleration toward target
    const framesForDuration = (duration / 1000) * 60; // Convert ms to frame count
    const moveRatio = 1 - (1 / framesForDuration) ** 2; // Ease-out
    this.viewportY += distance * moveRatio;

    // Fire scroll event (use floor to convert fractional to integer for API)
    const intViewportY = Math.floor(this.viewportY);
    this.scrollEmitter.fire(intViewportY);

    // Show scrollbar during animation
    const scrollbackLength = this.getScrollbackLength();
    if (scrollbackLength > 0) {
      this.showScrollbar();
    }

    // Continue animation
    this.scrollAnimationFrame = requestAnimationFrame(this.animateScroll);
  };

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    // Stop render loop and clear write queue
    this.cancelRenderLoop();
    this.writeQueue.length = 0;

    this.tickPacer.cancel();

    // Stop smooth scroll animation
    if (this.scrollAnimationFrame) {
      cancelAnimationFrame(this.scrollAnimationFrame);
      this.scrollAnimationFrame = undefined;
    }

    // Clear mouse move throttle timeout
    if (this.mouseMoveThrottleTimeout) {
      clearTimeout(this.mouseMoveThrottleTimeout);
      this.mouseMoveThrottleTimeout = undefined;
    }
    this.pendingMouseMove = undefined;

    // Dispose addons
    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons = [];

    // Clean up components
    this.cleanupComponents();

    // Dispose event emitters
    this.dataEmitter.dispose();
    this.resizeEmitter.dispose();
    this.bellEmitter.dispose();
    this.selectionChangeEmitter.dispose();
    this.keyEmitter.dispose();
    this.titleChangeEmitter.dispose();
    this.scrollEmitter.dispose();
    this.renderEmitter.dispose();
    this.cursorMoveEmitter.dispose();
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Sends focus that lands on the container itself to the textarea. (webtty)
   */
  private handleFocusIn = (e: FocusEvent): void => {
    if (e.target === this.element) this.textarea?.focus();
  };

  private handleWindowFocus = (): void => {
    if (this.element && document.activeElement === this.element) this.textarea?.focus();
  };

  /**
   * The cursor cell's top-left corner in CSS pixels relative to the container's
   * padding box, or undefined before open(). (webtty)
   */
  getCursorCellOffset(): { left: number; top: number } | undefined {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return undefined;
    const metrics = this.renderer.getMetrics();
    return cursorCellOffset(
      this.wasmTerm.getCursor(),
      this.viewportY,
      { cols: this.cols, rows: this.rows },
      metrics,
      { left: this.canvas.offsetLeft, top: this.canvas.offsetTop }
    );
  }

  /**
   * Moves the textarea onto the cursor cell, one cell high, writing only styles
   * that changed. macOS places the dictation microphone and IME candidate window
   * by its caret, so it stays anchored before a composition starts too. (webtty)
   */
  private anchorTextarea(): void {
    const textarea = this.textarea;
    const spot = this.getCursorCellOffset();
    if (!textarea || !spot) return;
    // The right-click copy flow repositions the textarea while it holds the
    // selection; leave it alone until that flow restores it.
    if (textarea.style.position === 'fixed' && textarea.style.pointerEvents === 'auto') return;
    if (textarea.style.position !== 'absolute') textarea.style.position = 'absolute';
    setStylePx(textarea, 'left', spot.left);
    setStylePx(textarea, 'top', spot.top);
    setStylePx(textarea, 'width', 1);
    setStylePx(textarea, 'height', this.renderer!.getMetrics().height);
  }

  /**
   * Cancel the render loop
   */
  private cancelRenderLoop(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = undefined;
    }
  }

  /**
   * Flush any writes that were queued during resize
   */
  private flushWriteQueue(): void {
    while (this.writeQueue.length > 0) {
      const data = this.writeQueue.shift()!;
      this.wasmTerm!.write(data);
    }
  }

  /**
   * Start the render loop
   */
  private startRenderLoop(): void {
    if (this.animationFrameId) return; // already running
    const loop = (now?: number) => {
      if (!this.isDisposed && this.isOpen) {
        this.beforeRender?.(now ?? performance.now());

        // Render using WASM's native dirty tracking
        // The render() method:
        // 1. Calls update() once to sync state and check dirty flags
        // 2. Only redraws dirty rows when forceAll=false
        // 3. Always calls clearDirty() at the end
        this.renderer!.render(this.wasmTerm!, false, this.viewportY, this, this.scrollbarOpacity);

        // Replies that arose outside write() reach the PTY within a frame (webtty, ADR 042)
        if (this.wasmTerm!.hasResponse()) this.processTerminalResponses();

        // Check for cursor movement (Phase 2: onCursorMove event)
        // Note: getCursor() reads from already-updated render state (from render() above)
        const cursor = this.wasmTerm!.getCursor();
        if (cursor.y !== this.lastCursorY) {
          this.lastCursorY = cursor.y;
          this.cursorMoveEmitter.fire();
        }

        // Keep the input textarea on the cursor cell (webtty)
        this.anchorTextarea();

        // Note: onRender event is intentionally not fired in the render loop
        // to avoid performance issues. For now, consumers can use requestAnimationFrame
        // if they need frame-by-frame updates.

        this.animationFrameId = requestAnimationFrame(loop);
      }
    };
    loop();
  }

  /**
   * Get a line from native WASM scrollback buffer
   * Implements IScrollbackProvider
   */
  public getScrollbackLine(offset: number): GhosttyCell[] | null {
    if (!this.wasmTerm) return null;
    return this.wasmTerm.getScrollbackLine(offset);
  }

  /**
   * Get scrollback length from native WASM
   * Implements IScrollbackProvider
   */
  public getScrollbackLength(): number {
    if (!this.wasmTerm) return 0;
    return this.wasmTerm.getScrollbackLength();
  }

  /**
   * Get the full grapheme string for a scrollback cell
   * Implements IScrollbackProvider
   */
  public getScrollbackGraphemeString(offset: number, col: number): string {
    if (!this.wasmTerm) return ' ';
    return this.wasmTerm.getScrollbackGraphemeString(offset, col);
  }

  /**
   * Clean up components (called on dispose or error)
   */
  private cleanupComponents(): void {
    // Dispose selection manager
    if (this.selectionManager) {
      this.selectionManager.dispose();
      this.selectionManager = undefined;
    }

    // Dispose input handler
    if (this.inputHandler) {
      this.inputHandler.dispose();
      this.inputHandler = undefined;
    }

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = undefined;
    }

    // Remove canvas from DOM
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = undefined;
    }

    // Remove textarea from DOM
    if (this.textarea && this.textarea.parentNode) {
      this.textarea.parentNode.removeChild(this.textarea);
      this.textarea = undefined;
    }

    // Remove event listeners
    if (this.element) {
      this.element.removeEventListener('wheel', this.handleWheel);
      this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.element.removeEventListener('mousemove', this.handleMouseMove);
      this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      this.element.removeEventListener('click', this.handleClick);
      this.element.removeEventListener('focusin', this.handleFocusIn);

      // Remove contenteditable and accessibility attributes added in open()
      this.element.removeAttribute('contenteditable');
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('aria-multiline');
    }

    // Remove document-level listeners (only if opened)
    if (this.isOpen && typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleMouseUp);
      window.removeEventListener('focus', this.handleWindowFocus);
    }

    // Clean up scrollbar timers
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // Dispose link detector
    if (this.linkDetector) {
      this.linkDetector.dispose();
      this.linkDetector = undefined;
    }

    // Free WASM terminal
    if (this.wasmTerm) {
      this.wasmTerm.free();
      this.wasmTerm = undefined;
    }

    // Clear references
    this.ghostty = undefined;
    this.element = undefined;
    this.textarea = undefined;
  }

  /**
   * Assert terminal is open (throw if not)
   */
  private assertOpen(): void {
    if (this.isDisposed) {
      throw new Error('Terminal has been disposed');
    }
    if (!this.isOpen) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
  }

  /**
   * Handle mouse move for link hover detection and scrollbar dragging
   * Throttled to avoid blocking scroll events (except when dragging scrollbar)
   */
  private handleMouseMove = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    // If dragging scrollbar, handle immediately without throttling
    if (this.isDraggingScrollbar) {
      this.processScrollbarDrag(e);
      return;
    }

    if (!this.linkDetector) return;

    // Throttle to ~60fps (16ms) to avoid blocking scroll/other events
    if (this.mouseMoveThrottleTimeout) {
      this.pendingMouseMove = e;
      return;
    }

    this.processMouseMove(e);

    this.mouseMoveThrottleTimeout = window.setTimeout(() => {
      this.mouseMoveThrottleTimeout = undefined;
      if (this.pendingMouseMove) {
        const pending = this.pendingMouseMove;
        this.pendingMouseMove = undefined;
        this.processMouseMove(pending);
      }
    }, 16);
  };

  /**
   * Process mouse move for link detection (internal, called by throttled handler)
   */
  private processMouseMove(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Convert mouse coordinates to terminal cell position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    // Viewport row 0 starts the scroll offset below the canvas top (webtty, ADR 043)
    const y = Math.floor(
      (e.clientY - rect.top - this.renderer.scrollOffset) / this.renderer.charHeight
    );

    // Get hyperlink_id directly from the cell at this position
    // Must account for viewportY (scrollback position)
    const viewportRow = y; // Row in the viewport (0 to rows-1)
    let hyperlinkId = 0;

    // When scrolled, fetch from scrollback or screen based on position
    // NOTE: viewportY may be fractional during smooth scrolling. The renderer
    // uses Math.floor(viewportY) when mapping viewport rows to scrollback vs
    // screen; we mirror that logic here so link hit-testing matches what the
    // user sees on screen.
    let line: GhosttyCell[] | null = null;
    const rawViewportY = this.getViewportY();
    const viewportY = Math.max(0, Math.floor(rawViewportY));
    if (viewportY > 0) {
      const scrollbackLength = this.wasmTerm.getScrollbackLength();
      if (viewportRow < viewportY) {
        // Mouse is over scrollback content
        const scrollbackOffset = scrollbackLength - viewportY + viewportRow;
        line = this.wasmTerm.getScrollbackLine(scrollbackOffset);
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportY;
        line = this.wasmTerm.getLine(screenRow);
      }
    } else {
      // At bottom - just use screen buffer
      line = this.wasmTerm.getLine(viewportRow);
    }

    if (line && x >= 0 && x < line.length) {
      hyperlinkId = line[x].hyperlink_id;
    }

    // Update renderer for underline rendering
    const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
    if (hyperlinkId !== previousHyperlinkId) {
      this.renderer.setHoveredHyperlinkId(hyperlinkId);

      // The 60fps render loop will pick up the change automatically
      // No need to force a render - this keeps performance smooth
    }

    // Check if there's a link at this position (for click handling and cursor)
    // Buffer API expects absolute buffer coordinates (including scrollback)
    // When scrolled, we need to adjust the buffer row based on viewportY
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForBuffer = this.getViewportY();
    const viewportYForBuffer = Math.max(0, Math.floor(rawViewportYForBuffer));

    if (viewportYForBuffer > 0) {
      // When scrolled, the buffer row depends on where in the viewport we are
      if (viewportRow < viewportYForBuffer) {
        // Mouse is over scrollback content
        bufferRow = scrollbackLength - viewportYForBuffer + viewportRow;
      } else {
        // Mouse is over screen content (bottom part of viewport)
        const screenRow = viewportRow - viewportYForBuffer;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      // At bottom - buffer row is scrollback + screen row
      bufferRow = scrollbackLength + viewportRow;
    }

    // Make async call non-blocking - don't await
    this.linkDetector
      .getLinkAt(x, bufferRow)
      .then((link) => {
        // Update hover state for cursor changes and click handling
        if (link !== this.currentHoveredLink) {
          // Notify old link we're leaving
          this.currentHoveredLink?.hover?.(false);

          // Update current link
          this.currentHoveredLink = link;

          // Notify new link we're entering
          link?.hover?.(true);

          // Update cursor style on both container and canvas
          const cursorStyle = mouseCursorFor(link);
          if (this.element) {
            this.element.style.cursor = cursorStyle;
          }
          if (this.canvas) {
            this.canvas.style.cursor = cursorStyle;
          }

          // Update renderer for underline (for regex URLs without hyperlink_id)
          if (this.renderer) {
            if (link) {
              // Convert buffer coordinates to viewport coordinates
              const scrollbackLength = this.wasmTerm?.getScrollbackLength() || 0;

              // Calculate viewport Y for start and end positions
              // Use floored viewportY so overlay rows match renderer & selection
              const rawViewportYForLinks = this.getViewportY();
              const viewportYForLinks = Math.max(0, Math.floor(rawViewportYForLinks));
              const startViewportY = link.range.start.y - scrollbackLength + viewportYForLinks;
              const endViewportY = link.range.end.y - scrollbackLength + viewportYForLinks;

              // Only show underline if link is visible in viewport
              if (startViewportY < this.rows && endViewportY >= 0) {
                this.renderer.setHoveredLinkRange({
                  startX: link.range.start.x,
                  startY: Math.max(0, startViewportY),
                  endX: link.range.end.x,
                  endY: Math.min(this.rows - 1, endViewportY),
                });
              } else {
                this.renderer.setHoveredLinkRange(null);
              }
            } else {
              this.renderer.setHoveredLinkRange(null);
            }
          }
        }
      })
      .catch((err) => {
        console.warn('Link detection error:', err);
      });
  }

  /**
   * Handle mouse leave to clear link hover
   */
  private handleMouseLeave = (): void => {
    // Clear hyperlink underline
    if (this.renderer && this.wasmTerm) {
      const previousHyperlinkId = (this.renderer as any).hoveredHyperlinkId || 0;
      if (previousHyperlinkId > 0) {
        this.renderer.setHoveredHyperlinkId(0);

        // The 60fps render loop will pick up the change automatically
      }
      // Clear regex link underline
      this.renderer.setHoveredLinkRange(null);
    }

    if (this.currentHoveredLink) {
      // Notify link we're leaving
      this.currentHoveredLink.hover?.(false);

      // Clear hovered link
      this.currentHoveredLink = undefined;

      // Reset cursor
      if (this.element) {
        this.element.style.cursor = mouseCursorFor(undefined);
        if (this.canvas) {
          this.canvas.style.cursor = mouseCursorFor(undefined);
        }
      }
    }
  };

  /**
   * Handle mouse click for link activation
   */
  private handleClick = async (e: MouseEvent): Promise<void> => {
    // For more reliable clicking, detect the link at click time
    // rather than relying on cached hover state (avoids async races)
    if (!this.canvas || !this.renderer || !this.linkDetector || !this.wasmTerm) return;

    // Get click position
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.renderer.charWidth);
    // Viewport row 0 starts the scroll offset below the canvas top (webtty, ADR 043)
    const y = Math.floor(
      (e.clientY - rect.top - this.renderer.scrollOffset) / this.renderer.charHeight
    );

    // Calculate buffer row (same logic as processMouseMove)
    const viewportRow = y;
    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    let bufferRow: number;

    // Use floored viewportY for buffer mapping (must match renderer & selection)
    const rawViewportYForClick = this.getViewportY();
    const viewportYForClick = Math.max(0, Math.floor(rawViewportYForClick));

    if (viewportYForClick > 0) {
      if (viewportRow < viewportYForClick) {
        bufferRow = scrollbackLength - viewportYForClick + viewportRow;
      } else {
        const screenRow = viewportRow - viewportYForClick;
        bufferRow = scrollbackLength + screenRow;
      }
    } else {
      bufferRow = scrollbackLength + viewportRow;
    }

    // Get the link at this position
    const link = await this.linkDetector.getLinkAt(x, bufferRow);

    if (link) {
      // Activate link
      link.activate(e);

      // Prevent default action if modifier key held
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    }
  };

  /**
   * Handle wheel events for scrolling (Phase 2)
   */
  private handleWheel = (e: WheelEvent): void => {
    // Always prevent default browser scrolling
    e.preventDefault();
    e.stopPropagation();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      return;
    }

    // App tracks the mouse (e.g. vim `set mouse=a`): report scroll ticks as SGR
    // buttons 64/65 at the cell under the pointer, on either screen.
    if (this.wasmTerm?.hasMouseTracking()) {
      const metrics = this.renderer?.getMetrics();
      if (!metrics || !this.canvas) return;
      // Every event, so the spread sees the time since the previous one (webtty, ADR 045)
      const spread = this.customWheelTickSpread?.(e) ?? { duration: 0 };
      const ticks = wheelTicks(
        this.wheelAccumulator,
        e,
        metrics.height,
        this.options.mouseScrollSpeed
      );
      if (ticks === 0) return;
      const rect = this.canvas.getBoundingClientRect();
      const col = Math.max(1, Math.floor((e.clientX - rect.left) / metrics.width) + 1);
      const row = Math.max(
        1,
        Math.floor((e.clientY - rect.top - this.renderer!.scrollOffset) / metrics.height) + 1
      );
      this.tickPacer.push(
        wheelSgr(Math.sign(ticks), col, row),
        Math.sign(ticks),
        Math.abs(ticks),
        spread
      );
      return;
    }

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application, one per line of
      // travel, paced like the SGR ticks above (webtty, ADR 045)
      const spread = this.customWheelTickSpread?.(e) ?? { duration: 0 };
      const lines = wheelArrows(
        this.arrowAccumulator,
        e,
        this.renderer?.getMetrics()?.height ?? 20,
        this.rows
      );
      const dir = Math.sign(lines);
      if (lines !== 0) {
        // Application cursor keys (DECCKM), as less sets: ESC O A/B, else ESC [ A/B
        const app = this.wasmTerm?.getMode(1, false) ?? false;
        const seq = (app ? '\x1BO' : '\x1B[') + (dir < 0 ? 'A' : 'B');
        this.tickPacer.push(seq, dir, Math.abs(lines), spread);
      }
    } else {
      // Normal screen: scroll viewport through history with smooth scrolling
      // Handle different deltaMode values for better trackpad/mouse support
      let deltaLines: number;

      if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        // Pixel mode (trackpads): convert pixels to lines
        // Use actual line height from renderer for accurate conversion
        const lineHeight = this.renderer?.getMetrics()?.height ?? 20;
        deltaLines = e.deltaY / lineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Line mode (some mice): use directly
        deltaLines = e.deltaY;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Page mode (rare): convert pages to lines
        deltaLines = e.deltaY * this.rows;
      } else {
        // Fallback: assume pixel mode with legacy divisor
        deltaLines = e.deltaY / 33;
      }

      // Use smooth scrolling for any amount (no rounding needed)
      if (deltaLines !== 0) {
        // Calculate target position
        // deltaY > 0 = scroll down (decrease viewportY)
        // deltaY < 0 = scroll up (increase viewportY)
        const targetY = this.viewportY - deltaLines;
        this.smoothScrollTo(targetY);
      }
    }
  };

  /**
   * Handle mouse down for scrollbar interaction
   */
  private handleMouseDown = (e: MouseEvent): void => {
    if (!this.canvas || !this.renderer || !this.wasmTerm) return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return; // No scrollbar if no scrollback

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    // The scrollbar is painted over the rows in view (webtty, ADR 043)
    const mouseY = e.clientY - rect.top - this.renderer.scrollOffset;

    // Calculate scrollbar dimensions (match renderer's logic)
    // Use rect dimensions which are already in CSS pixels
    const canvasWidth = rect.width;
    const canvasHeight = rect.height;
    const scrollbarWidth = 8;
    const scrollbarX = canvasWidth - scrollbarWidth - 4;
    const scrollbarPadding = 4;

    // Check if click is in scrollbar area
    if (mouseX >= scrollbarX && mouseX <= scrollbarX + scrollbarWidth) {
      // Prevent default and stop propagation to prevent text selection
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation(); // Stop SelectionManager from seeing this event

      // Calculate scrollbar thumb position and size
      const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
      const visibleRows = this.rows;
      const totalLines = scrollbackLength + visibleRows;
      const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);
      const scrollPosition = this.viewportY / scrollbackLength;
      const thumbY = scrollbarPadding + (scrollbarTrackHeight - thumbHeight) * (1 - scrollPosition);

      // Check if click is on thumb
      if (mouseY >= thumbY && mouseY <= thumbY + thumbHeight) {
        // Start dragging thumb
        this.isDraggingScrollbar = true;
        this.scrollbarDragStart = mouseY;
        this.scrollbarDragStartViewportY = this.viewportY;

        // Prevent text selection during drag
        if (this.canvas) {
          this.canvas.style.userSelect = 'none';
          this.canvas.style.webkitUserSelect = 'none';
        }
      } else {
        // Click on track - jump to position
        const relativeY = mouseY - scrollbarPadding;
        const scrollFraction = 1 - relativeY / scrollbarTrackHeight; // Inverted: top = 1, bottom = 0
        const targetViewportY = Math.round(scrollFraction * scrollbackLength);
        this.scrollToLine(Math.max(0, Math.min(scrollbackLength, targetViewportY)));
      }
    }
  };

  /**
   * Handle mouse up for scrollbar drag
   */
  private handleMouseUp = (): void => {
    if (this.isDraggingScrollbar) {
      this.isDraggingScrollbar = false;
      this.scrollbarDragStart = null;

      // Restore text selection
      if (this.canvas) {
        this.canvas.style.userSelect = '';
        this.canvas.style.webkitUserSelect = '';
      }

      // Schedule auto-hide after drag ends
      if (this.scrollbarVisible && this.getScrollbackLength() > 0) {
        this.showScrollbar(); // Reset the hide timer
      }
    }
  };

  /**
   * Process scrollbar drag movement
   */
  private processScrollbarDrag(e: MouseEvent): void {
    if (!this.canvas || !this.renderer || !this.wasmTerm || this.scrollbarDragStart === null)
      return;

    const scrollbackLength = this.wasmTerm.getScrollbackLength();
    if (scrollbackLength === 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const mouseY = e.clientY - rect.top - this.renderer.scrollOffset;

    // Calculate how much the mouse moved
    const deltaY = mouseY - this.scrollbarDragStart;

    // Convert mouse delta to viewport delta
    // Use rect height which is already in CSS pixels
    const canvasHeight = rect.height;
    const scrollbarPadding = 4;
    const scrollbarTrackHeight = canvasHeight - scrollbarPadding * 2;
    const visibleRows = this.rows;
    const totalLines = scrollbackLength + visibleRows;
    const thumbHeight = Math.max(20, (visibleRows / totalLines) * scrollbarTrackHeight);

    // Calculate scroll fraction from thumb movement
    // Note: thumb moves in opposite direction to viewport (thumb down = scroll down = viewportY decreases)
    const scrollFraction = -deltaY / (scrollbarTrackHeight - thumbHeight);
    const viewportDelta = Math.round(scrollFraction * scrollbackLength);

    const newViewportY = this.scrollbarDragStartViewportY + viewportDelta;
    this.scrollToLine(Math.max(0, Math.min(scrollbackLength, newViewportY)));
  }

  /**
   * Show scrollbar with fade-in and schedule auto-hide
   */
  private showScrollbar(): void {
    // Clear any existing hide timeout
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    // If not visible, start fade-in
    if (!this.scrollbarVisible) {
      this.scrollbarVisible = true;
      this.scrollbarOpacity = 0;
      this.fadeInScrollbar();
    } else {
      // Already visible, just ensure it's fully opaque
      this.scrollbarOpacity = 1;
    }

    // Schedule auto-hide (unless dragging)
    if (!this.isDraggingScrollbar) {
      this.scrollbarHideTimeout = window.setTimeout(() => {
        this.hideScrollbar();
      }, this.SCROLLBAR_HIDE_DELAY_MS);
    }
  }

  /**
   * Hide scrollbar with fade-out
   */
  private hideScrollbar(): void {
    if (this.scrollbarHideTimeout) {
      window.clearTimeout(this.scrollbarHideTimeout);
      this.scrollbarHideTimeout = undefined;
    }

    if (this.scrollbarVisible) {
      this.fadeOutScrollbar();
    }
  }

  /**
   * Fade in scrollbar
   */
  private fadeInScrollbar(): void {
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = progress;

      // Trigger render to show updated opacity
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    animate();
  }

  /**
   * Fade out scrollbar
   */
  private fadeOutScrollbar(): void {
    const startTime = Date.now();
    const startOpacity = this.scrollbarOpacity;
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / this.SCROLLBAR_FADE_DURATION_MS, 1);
      this.scrollbarOpacity = startOpacity * (1 - progress);

      // Trigger render to show updated opacity
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        this.scrollbarVisible = false;
        this.scrollbarOpacity = 0;
        // Final render to clear scrollbar completely
        if (this.renderer && this.wasmTerm) {
          this.renderer.render(this.wasmTerm, false, this.viewportY, this, 0);
        }
      }
    };
    animate();
  }

  /**
   * Process any pending terminal responses and emit them via onData.
   *
   * This handles escape sequences that require the terminal to send a response
   * back to the PTY, such as:
   * - DSR 6 (cursor position): Shell sends \x1b[6n, terminal responds with \x1b[row;colR
   * - DSR 5 (operating status): Shell sends \x1b[5n, terminal responds with \x1b[0n
   *
   * Without this, shells like nushell that rely on cursor position queries
   * will hang waiting for a response that never comes.
   *
   * Note: We loop to read all pending responses, not just one. This is important
   * when multiple queries are processed in a single write() call (e.g., when
   * buffered data is written all at once during terminal initialization).
   */
  private processTerminalResponses(): void {
    if (!this.wasmTerm) return;

    // Read all pending responses from the WASM terminal
    // Multiple responses can be queued if a single write() contained multiple queries
    while (true) {
      const response = this.wasmTerm.readResponse();
      if (response === null) break;
      // Send response back to the PTY via onData
      // This is the same path as user keyboard input
      this.dataEmitter.fire(response);
    }
  }

  /**
   * Check for title changes in written data (OSC sequences)
   * Simplified implementation - looks for OSC 0, 1, 2
   */
  private checkForTitleChange(data: string): void {
    // OSC sequences: ESC ] Ps ; Pt BEL or ESC ] Ps ; Pt ST
    // OSC 0 = icon + title, OSC 1 = icon, OSC 2 = title
    const oscRegex = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null = null;

    // biome-ignore lint/suspicious/noAssignInExpressions: Standard regex pattern
    while ((match = oscRegex.exec(data)) !== null) {
      const ps = match[1];
      const pt = match[2];

      // OSC 0 and OSC 2 set the title
      if (ps === '0' || ps === '2') {
        this.setTitle(pt);
      }
    }
  }

  /** Fires onTitleChange when the title differs from the current one. */
  private setTitle(title: string): void {
    if (title === this.currentTitle) return;
    this.currentTitle = title;
    this.titleChangeEmitter.fire(title);
  }

  // ============================================================================
  // Terminal Modes
  // ============================================================================

  /**
   * Query terminal mode state
   *
   * @param mode Mode number (e.g., 2004 for bracketed paste)
   * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
   * @returns true if mode is enabled
   */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    this.assertOpen();
    return this.wasmTerm!.getMode(mode, isAnsi);
  }

  /**
   * Check if bracketed paste mode is enabled
   */
  public hasBracketedPaste(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasBracketedPaste();
  }

  /**
   * Check if focus event reporting is enabled
   */
  public hasFocusEvents(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasFocusEvents();
  }

  /**
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}
