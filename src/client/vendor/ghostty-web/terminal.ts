/**
 * Terminal - Main terminal emulator class
 *
 * Provides an xterm.js-compatible API wrapping Ghostty's WASM terminal emulator.
 *
 * Usage:
 * ```typescript
 * import { Ghostty, Terminal } from 'ghostty-web';
 *
 * const term = new Terminal({ ghostty: await Ghostty.load() });
 * term.open(document.getElementById('container'));
 * term.write('Hello, World!\n');
 * term.onData(data => console.log('User typed:', data));
 * ```
 */

import { BufferNamespace } from './buffer';
import { EventEmitter } from './event-emitter';
import type {
  DesktopNotification,
  Ghostty,
  GhosttyCell,
  GhosttyTerminal,
  GhosttyTerminalConfig,
  MouseGeometry,
  SearchState,
} from './ghostty';
import { AT_ONCE, type Pace } from './glide';
import {
  InputHandler,
  type MouseEventReport,
  type MouseTrackingConfig,
  mouseMods,
} from './input-handler';
import type {
  IBufferNamespace,
  IDisposable,
  IEvent,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
} from './interfaces';
import { LinkDetector } from './link-detector';
import { MenuSource, rightClickAction } from './mouse-route';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { CanvasRenderer } from './renderer';
import { type FindAnchor, keptViewportY, viewportYToShow } from './search';
import { SelectionManager } from './selection-manager';
import type { ILink } from './types';
import {
  TickPacer,
  type WheelAccumulator,
  wheelArrowKey,
  wheelArrows,
  wheelTicks,
} from './wheel';

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

/**
 * The mouse encoder's geometry and a client position in it (ADR 049). Ghostty needs a
 * whole cell size, and webtty's CSS cell is fractional, so the units are device-pixel
 * cells: the cell is `cellPx` (the size Ghostty's size reports give, so SGR-pixels
 * positions agree with them), and CSS lengths are scaled by `cellPx` over the CSS cell.
 * The screen is the container `box`, so the padding around the grid is part of it and
 * Ghostty maps it to the nearest edge cell. The position is measured from the grid's
 * origin and then offset by the rounded padding, so rounding never moves a cell
 * boundary. (webtty)
 */
export function mouseSurface(
  clientX: number,
  clientY: number,
  grid: {
    left: number;
    top: number;
    cols: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  },
  box: { left: number; top: number; right: number; bottom: number },
  cellPx: { width: number; height: number }
): { geometry: MouseGeometry; x: number; y: number } {
  const sx = cellPx.width / grid.cellWidth;
  const sy = cellPx.height / grid.cellHeight;
  const left = Math.max(0, Math.round((grid.left - box.left) * sx));
  const top = Math.max(0, Math.round((grid.top - box.top) * sy));
  const gridRight = grid.left + grid.cols * grid.cellWidth;
  const gridBottom = grid.top + grid.rows * grid.cellHeight;
  const right = Math.max(0, Math.round((box.right - gridRight) * sx));
  const bottom = Math.max(0, Math.round((box.bottom - gridBottom) * sy));
  return {
    geometry: {
      screenWidth: left + grid.cols * cellPx.width + right,
      screenHeight: top + grid.rows * cellPx.height + bottom,
      cellWidth: cellPx.width,
      cellHeight: cellPx.height,
      paddingTop: top,
      paddingRight: right,
      paddingBottom: bottom,
      paddingLeft: left,
    },
    x: (clientX - grid.left) * sx + left,
    y: (clientY - grid.top) * sy + top,
  };
}

const MOUSE_REPORT_DECODER = new TextDecoder('utf-8', { fatal: true });

/** DEC private mode 1004: the app hears `CSI I` / `CSI O` on focus changes. (webtty, ADR 053) */
const FOCUS_EVENT_MODE = 1004;

/** The time the search may take in a frame (webtty, ADR 055) */
const FIND_STEP_MS = 4;

/**
 * A mouse report as text for the PTY, or '' when it is not valid UTF-8. Input travels as
 * text frames that the server writes as UTF-8, so a report with raw bytes above 0x7f
 * (X10 format past column or row 95, X10 buttons 8/9) would reach the app as different
 * bytes; it is dropped instead (ADR 049). (webtty)
 */
export function mouseReportText(bytes: Uint8Array): string {
  try {
    return MOUSE_REPORT_DECODER.decode(bytes);
  } catch {
    return '';
  }
}

/**
 * A cell's size in whole device pixels, for Ghostty's size reports
 * (XTWINOPS 14/16/18/19 t, mode 2048). Computed as kitty.ts's `deviceCellSize`
 * sizes image frames: the CSS cell times `devicePixelRatio`, rounded, at least 1.
 * (webtty, ADR 042)
 */
export function deviceCellPixels(cssCell: number, dpr: number): number {
  return Math.max(1, Math.round(cssCell * dpr));
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
  private titleChangeEmitter = new EventEmitter<string>();
  private scrollEmitter = new EventEmitter<number>();
  private pasteRequestEmitter = new EventEmitter<void>();
  private clipboardWriteEmitter = new EventEmitter<string>();
  private desktopNotificationEmitter = new EventEmitter<DesktopNotification>();
  private findChangeEmitter = new EventEmitter<SearchState>();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.dataEmitter.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.resizeEmitter.event;
  public readonly onBell: IEvent<void> = this.bellEmitter.event;
  public readonly onTitleChange: IEvent<string> = this.titleChangeEmitter.event;
  public readonly onScroll: IEvent<number> = this.scrollEmitter.event;
  /**
   * A right-click asks to paste the clipboard (`rightClickBehavior: "paste"`). The
   * embedder reads the clipboard, as for Ctrl+V. (webtty, ADR 051)
   */
  public readonly onPasteRequest: IEvent<void> = this.pasteRequestEmitter.event;
  /**
   * The program wrote the clipboard (OSC 52, OSC 1337 Copy, OSC 5522), with the text to
   * write, `''` to clear it. Fires only while the `clipboardWrite` option is on; the
   * embedder writes the browser clipboard. (webtty, ADR 052)
   */
  public readonly onClipboardWrite: IEvent<string> = this.clipboardWriteEmitter.event;
  /**
   * The program asked for a desktop notification (OSC 9, OSC 777 `notify`), with its
   * title (`''` for none) and body as plain text. Fires only while the
   * `desktopNotifications` option is on; the embedder shows it. (webtty, ADR 056)
   */
  public readonly onDesktopNotification: IEvent<DesktopNotification> =
    this.desktopNotificationEmitter.event;
  /** The match count or the selected match changed (webtty, ADR 055) */
  public readonly onFindChange: IEvent<SearchState> = this.findChangeEmitter.event;

  // Lifecycle state
  private isOpen = false;
  private isDisposed = false;
  private animationFrameId?: number;
  private writeQueue: Uint8Array[] = [];
  private awaitingEcho = false;

  // Addons
  private addons: ITerminalAddon[] = [];

  // Phase 1: Title tracking
  private currentTitle: string = '';

  // Focus reports (webtty, ADR 053): keyboard focus inside the container in a focused
  // window, and whether mode 1004 was on after the last write.
  private focused = false;
  private focusReporting = false;

  // A clearScreen waiting for the output to reach ground (webtty, ADR 054)
  private pendingClear = false;

  // Find (webtty, ADR 055): the needle ('' with no search open), whether the matches need
  // reading again and when they may be, where the selected match was when the view last
  // followed it, and the count last reported
  private findNeedle = '';
  private findStale = false;
  private findReadAt = 0;
  private findAnchor: FindAnchor | null = null;
  private findState: SearchState = { total: 0, selected: null };

  // Phase 2: Viewport and scrolling state
  public viewportY: number = 0; // Top line of viewport in scrollback buffer (0 = at bottom)
  private customWheelEventHandler?: (event: WheelEvent) => boolean;
  private wheelAccumulator: WheelAccumulator = { accum: 0, dir: 0 };
  // Whether a contextmenu came from a button or the keyboard (webtty, ADR 051)
  private readonly menuSource = new MenuSource();
  private arrowAccumulator: WheelAccumulator = { accum: 0, dir: 0 };
  private wheelPace?: (event: WheelEvent) => Pace;
  private beforeRender?: (now: number) => void;
  private readonly tickPacer = new TickPacer((data) => this.dataEmitter.fire(data));

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

  constructor(options: ITerminalOptions) {
    this.ghostty = options.ghostty;

    // Create base options object with all defaults (excluding ghostty)
    const baseOptions = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cursorBlink: options.cursorBlink ?? false,
      cursorStyle: options.cursorStyle ?? 'block',
      theme: options.theme ?? {},
      scrollbackLines: options.scrollbackLines,
      fontSize: options.fontSize ?? 15,
      fontFamily: options.fontFamily ?? 'monospace',
      allowTransparency: options.allowTransparency ?? false,
      convertEol: options.convertEol ?? false,
      disableStdin: options.disableStdin ?? false,
      mouseScrollSpeed: options.mouseScrollSpeed ?? 1,
      copyOnSelect: options.copyOnSelect ?? true,
      rightClickBehavior: options.rightClickBehavior ?? 'contextMenu',
      clipboardWrite: options.clipboardWrite ?? true,
      desktopNotifications: options.desktopNotifications ?? true,
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
        // The engine's default; the renderer draws what the engine reports (webtty, ADR 049)
        this.wasmTerm?.setDefaultCursor(this.options.cursorStyle, this.options.cursorBlink);
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
  private buildWasmConfig(): GhosttyTerminalConfig {
    const theme = this.options.theme;
    const scrollbackLines = this.options.scrollbackLines;

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
      scrollbackLines,
      fgColor: fg,
      bgColor: bg,
      cursorColor: cursor,
      palette: paletteColors,
      cursorStyle: this.options.cursorStyle,
      cursorBlink: this.options.cursorBlink,
      clipboardWrite: this.options.clipboardWrite,
      desktopNotifications: this.options.desktopNotifications,
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
      // Terminal focus for mode 1004: a window blur or focus reaches the focused element
      // as focusout / focusin too. (webtty, ADR 053)
      parent.addEventListener('focusin', this.handleFocusGained);
      parent.addEventListener('focusout', this.handleFocusLost);

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

      // Cell pixels for Ghostty's size reports, before the first write,
      // so a reply never says 0 px. Mode 2048 cannot be on yet. (webtty, ADR 042)
      this.syncCellPixelSize();

      // Create mouse tracking configuration. Reports are encoded by Ghostty (webtty, ADR 049)
      const mouseConfig: MouseTrackingConfig = {
        hasMouseTracking: () => this.wasmTerm?.hasMouseTracking() ?? false,
        encode: (event) => this.encodeMouse(event),
      };

      // Create input handler
      this.inputHandler = new InputHandler(
        this.ghostty!,
        parent,
        this.handleInput,
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

      // Every right-click and keyboard menu goes through handleContextMenu (webtty, ADR 051)
      parent.addEventListener('mousedown', this.handleMenuPress, { capture: true });
      parent.addEventListener('keydown', this.handleMenuKey, { capture: true });
      parent.addEventListener('contextmenu', this.handleContextMenu, { capture: true });

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
   * Pastes text as Ghostty does (`ghostty_terminal_paste`): bracketed while the app has
   * mode 2004 on, unsafe control bytes replaced with spaces, and newlines sent as CR
   * without 2004. The bytes go out through onData. (webtty: upstream bracketed the text
   * as it was, and only with 2004 on; ADR 049)
   */
  paste(text: string): void {
    this.assertOpen();
    if (this.options.disableStdin) return;
    // Ghostty always scrolls to the bottom on a paste (webtty, ADR 055)
    this.scrollToBottom();
    this.wasmTerm!.paste(text);
    this.processTerminalResponses();
  }

  /**
   * Finds `needle` in the scrollback and on screen with libghostty-vt's search, as
   * Ghostty's `search` action does: every match is highlighted, none selected. The
   * search runs in the render loop, a few milliseconds a frame. `''` ends it.
   * (webtty, ADR 055)
   */
  find(needle: string): void {
    this.findNeedle = needle;
    this.wasmTerm?.setSearch(needle);
    this.findAnchor = null;
    this.findStale = !!needle;
    this.findReadAt = 0;
    this.renderer?.setSearchHighlights(null);
    this.reportFind();
  }

  /** Ends the search and clears its highlights (Ghostty's `end_search`). */
  endFind(): void {
    this.find('');
  }

  /** Whether a search is open. */
  get finding(): boolean {
    return this.findNeedle !== '';
  }

  /**
   * Selects the next match, toward older output (Ghostty's `navigate_search:next`), and
   * scrolls to it if none of its rows is in view. False with no search open.
   */
  findNext(): boolean {
    return this.selectMatch('next');
  }

  /** Selects the previous match, toward newer output. False with no search open. */
  findPrevious(): boolean {
    return this.selectMatch('previous');
  }

  private selectMatch(direction: 'next' | 'previous'): boolean {
    if (!this.findNeedle || !this.wasmTerm) return false;
    this.wasmTerm.searchSelect(direction);
    const match = this.wasmTerm.searchSelectedMatch();
    if (match) {
      const y = viewportYToShow(match, this.getScrollbackLength(), this.viewportY, this.rows);
      if (y !== null) this.scrollToLine(y);
    }
    this.findAnchor = match && { row: match.start.row, scrollback: this.getScrollbackLength() };
    this.findStale = true;
    this.findReadAt = 0;
    this.reportFind();
    return true;
  }

  /**
   * Runs the search for a few milliseconds and, when its results changed, gives the
   * renderer the matches. Reading them takes a few milliseconds with tens of thousands,
   * so while output keeps changing them they are read at most every ten times the last
   * read took. A scrolled view on a selected match is kept on its rows.
   */
  private stepFind(now: number): void {
    const wasmTerm = this.wasmTerm;
    if (!this.findNeedle || !wasmTerm) return;
    if (wasmTerm.searchStep(FIND_STEP_MS)) {
      this.findStale = true;
      this.reportFind();
    }
    if (!this.findStale || now < this.findReadAt) return;
    const started = performance.now();
    const selected = wasmTerm.searchSelectedMatch();
    this.renderer?.setSearchHighlights({ matches: wasmTerm.searchMatches(), selected });
    this.findStale = false;
    this.findReadAt = now + (performance.now() - started) * 10;
    const scrollback = this.getScrollbackLength();
    if (selected && this.findAnchor && this.viewportY > 0) {
      this.scrollToLine(keptViewportY(this.viewportY, this.findAnchor, selected.start.row, scrollback));
    }
    this.findAnchor = selected && { row: selected.start.row, scrollback };
  }

  /** Fires onFindChange if the count or the selected match changed. */
  private reportFind(): void {
    const state = this.wasmTerm?.searchState() ?? { total: 0, selected: null };
    if (state.total === this.findState.total && state.selected === this.findState.selected) {
      return;
    }
    this.findState = state;
    this.findChangeEmitter.fire(state);
  }

  /**
   * Ghostty's `clear_screen` (Cmd+K): clears the selection and the scrollback, then at a
   * shell prompt the screen, sending FF so the shell redraws its prompt, and elsewhere the
   * rows above the cursor, whose row becomes the top one. Returns false, doing nothing, on
   * the alternate screen, where the key is the app's. The erasing is written to the
   * terminal, not the PTY, and so waits for output cut off inside a sequence to finish
   * it. (webtty, ADR 054)
   */
  clearScreen(): boolean {
    this.assertOpen();
    if (this.wasmTerm!.isAlternateScreen()) return false;
    this.clearSelection();
    this.pendingClear = true;
    this.writeInternal(new Uint8Array(0));
    return true;
  }

  /** The erasing of `clearScreen`, for when the parser is at ground. */
  private writeClear(): void {
    const wasmTerm = this.wasmTerm!;
    // The output before it may have turned the alternate screen on
    if (wasmTerm.isAlternateScreen()) return;
    if (wasmTerm.cursorAtPrompt()) {
      // ED 2 at a prompt moves the screen into the scrollback, so ED 3 comes after it
      wasmTerm.write('\x1b[2J\x1b[3J');
      if (!this.options.disableStdin) this.dataEmitter.fire('\x0c');
    } else {
      const y = wasmTerm.getCursor().y;
      wasmTerm.write(`${y > 0 ? `\x1b[${y}S\x1b[${y}A` : ''}\x1b[3J`);
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

    // A waiting clear goes in where the output reaches ground (webtty, ADR 054)
    if (this.pendingClear) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const n = this.wasmTerm!.writeUntilGround(bytes);
      if (n !== null) {
        this.pendingClear = false;
        this.writeClear();
      }
      data = bytes.subarray(n ?? bytes.length);
    }

    // Write directly to WASM terminal (handles VT parsing internally)
    this.wasmTerm!.write(data);

    // Process any responses generated by the terminal (e.g., DSR cursor position)
    // These need to be sent back to the PTY via onData
    this.processTerminalResponses();

    // Ghostty reports the focus when the app turns mode 1004 on (webtty, ADR 053)
    const focusReporting = this.wasmTerm!.getMode(FOCUS_EVENT_MODE);
    if (focusReporting && !this.focusReporting) this.reportFocus();
    this.focusReporting = focusReporting;

    // Bell, title (OSC 0/2), clipboard writes (OSC 52) and desktop notifications (OSC 9,
    // OSC 777) as Ghostty reported them (webtty, ADR 042, ADR 052, ADR 056)
    const effects = this.wasmTerm!.readEffects();
    if (effects.bell) this.bellEmitter.fire();
    if (effects.title !== null) this.setTitle(effects.title);
    if (effects.clipboard !== null) this.clipboardWriteEmitter.fire(effects.clipboard);
    for (const n of effects.notifications) this.desktopNotificationEmitter.fire(n);

    // Invalidate link cache (content changed)
    this.linkDetector?.invalidateCache();

    // Phase 2: Auto-scroll to bottom on new output (xterm.js behavior), except while the
    // view is on a selected match: stepFind keeps it on its rows. The alternate screen
    // has no scrollback to keep a view in, and its matches are its own (webtty, ADR 055)
    if (
      this.viewportY !== 0 &&
      (!this.findAnchor || this.wasmTerm!.isAlternateScreen())
    ) {
      this.scrollToBottom();
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
      // The device-pixel cell size goes in the same call, so a change of grid and
      // pixels is one size report. (webtty, ADR 042)
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
   * Ghostty makes one size update. (webtty, ADR 042)
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
    // The new engine starts with mode 1004 off (webtty, ADR 053)
    this.focusReporting = false;
    // A clear waiting for the old engine's output is not for the new one (webtty, ADR 054)
    this.pendingClear = false;
    // A search goes on in the new engine (webtty, ADR 055)
    if (this.findNeedle) this.find(this.findNeedle);
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
  /**
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  // ==========================================================================
  // Phase 1: Custom Event Handlers
  // ==========================================================================

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
   * tracking, or arrow keys on the alternate screen); without it they go at once.
   * Called once for each such event. (webtty, ADR 045)
   */
  public attachWheelPace(pace?: (event: WheelEvent) => Pace): void {
    this.wheelPace = pace;
  }

  /**
   * Runs `callback` in every frame of the render loop, just before it renders, so
   * an animation that moves the viewport shows in the same frame. (webtty, ADR 045)
   */
  public attachBeforeRender(callback?: (now: number) => void): void {
    this.beforeRender = callback;
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
    this.titleChangeEmitter.dispose();
    this.scrollEmitter.dispose();
    this.pasteRequestEmitter.dispose();
    this.clipboardWriteEmitter.dispose();
    this.desktopNotificationEmitter.dispose();
    this.findChangeEmitter.dispose();
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

  /** Focus came into the container, or its window got focus back. (webtty, ADR 053) */
  private handleFocusGained = (): void => {
    this.setFocused(true);
  };

  /**
   * Focus left the container, or its window lost focus (no `relatedTarget`). A move
   * inside it, the container passing focus on to the textarea, is not a change.
   * (webtty, ADR 053)
   */
  private handleFocusLost = (e: FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (next && this.element?.contains(next)) return;
    this.setFocused(false);
  };

  private setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    if (this.wasmTerm?.getMode(FOCUS_EVENT_MODE)) this.reportFocus();
  }

  /**
   * Sends the current focus if mode 1004 is on, for a new connection to the app: reports
   * sent while there was none were dropped. (webtty, ADR 053)
   */
  resyncFocus(): void {
    if (this.wasmTerm?.getMode(FOCUS_EVENT_MODE)) this.reportFocus();
  }

  /** Sends `CSI I` or `CSI O` for the current focus, encoded by Ghostty. (webtty, ADR 053) */
  private reportFocus(): void {
    if (this.options.disableStdin || !this.wasmTerm) return;
    const report = new TextDecoder().decode(this.wasmTerm.encodeFocus(this.focused));
    if (report) this.dataEmitter.fire(report);
  }

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
        this.stepFind(now ?? performance.now());

        // Render using WASM's native dirty tracking
        // The render() method:
        // 1. Calls update() once to sync state and check dirty flags
        // 2. Only redraws dirty rows when forceAll=false
        // 3. Always calls clearDirty() at the end
        this.renderer!.render(this.wasmTerm!, false, this.viewportY, this, this.scrollbarOpacity);

        // Replies that arose outside write() reach the PTY within a frame (webtty, ADR 042)
        if (this.wasmTerm!.hasResponse()) this.processTerminalResponses();

        // Keep the input textarea on the cursor cell (webtty)
        this.anchorTextarea();

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
      this.element.removeEventListener('wheel', this.handleWheel, { capture: true });
      this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.element.removeEventListener('mousemove', this.handleMouseMove);
      this.element.removeEventListener('mouseleave', this.handleMouseLeave);
      this.element.removeEventListener('click', this.handleClick);
      this.element.removeEventListener('focusin', this.handleFocusIn);
      this.element.removeEventListener('focusin', this.handleFocusGained);
      this.element.removeEventListener('focusout', this.handleFocusLost);
      this.element.removeEventListener('mousedown', this.handleMenuPress, { capture: true });
      this.element.removeEventListener('keydown', this.handleMenuKey, { capture: true });
      this.element.removeEventListener('contextmenu', this.handleContextMenu, {
        capture: true,
      });

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

    const viewportRow = y; // Row in the viewport (0 to rows-1)

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

          // Update renderer for underline: the link's own range, OSC 8 or regex (webtty)
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
    // Clear the link underline
    if (this.renderer && this.wasmTerm) {
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
    // Cancel only pinch and ctrl+wheel, which would zoom the page. A cancelled wheel
    // event makes Chrome hold the gesture's next event until the page has handled it,
    // which put scrolling about a frame behind native; nothing else on the page scrolls,
    // and overscroll-behavior stops rubber-banding and swipe-back. (webtty, ADR 045)
    if (e.ctrlKey) e.preventDefault();
    e.stopPropagation();

    // Allow custom handler to override
    if (this.customWheelEventHandler && this.customWheelEventHandler(e)) {
      return;
    }

    // App tracks the mouse (e.g. vim `set mouse=a`): report scroll ticks as mouse
    // buttons 4/5 (SGR 64/65) at the cell under the pointer, on either screen.
    if (this.wasmTerm?.hasMouseTracking()) {
      const metrics = this.renderer?.getMetrics();
      if (!metrics || !this.canvas) return;
      const pace = this.wheelPace?.(e) ?? AT_ONCE;
      const ticks = wheelTicks(
        this.wheelAccumulator,
        e,
        metrics.height,
        this.options.mouseScrollSpeed
      );
      if (ticks === 0) return;
      // One tick, a press of button 4 (up) or 5 (down) at the pointer's cell as Ghostty
      // encodes it, repeated by the pacer. Nothing in X10 mode 9. (webtty, ADR 049)
      const tick = this.encodeMouse({
        action: 'press',
        button: ticks < 0 ? 'four' : 'five',
        mods: mouseMods(e),
        clientX: e.clientX,
        clientY: e.clientY,
        anyButtonPressed: false,
      });
      if (tick) this.tickPacer.push(tick, Math.sign(ticks), Math.abs(ticks), pace);
      return;
    }

    // Check if in alternate screen mode (vim, less, htop, etc.)
    const isAltScreen = this.wasmTerm?.isAlternateScreen() ?? false;

    if (isAltScreen) {
      // Alternate screen: send arrow keys to the application, one per line of
      // travel, paced like the SGR ticks above (webtty, ADR 045)
      const pace = this.wheelPace?.(e) ?? AT_ONCE;
      const lines = wheelArrows(
        this.arrowAccumulator,
        e,
        this.renderer?.getMetrics()?.height ?? 20,
        this.rows
      );
      if (lines !== 0) {
        const dir = Math.sign(lines);
        const key = wheelArrowKey(dir, this.wasmTerm?.getMode(1, false) ?? false);
        this.tickPacer.push(key, dir, Math.abs(lines), pace);
      }
    }
    // The normal screen's scrollback is scrolled by the custom handler (webtty's
    // SmoothScroll, ADR 040, ADR 045); upstream's easing here is removed.
  };

  /**
   * A mouse report at a client position, encoded by Ghostty's mouse encoder in the
   * app's tracking mode and format (`mouseSurface`, `mouseReportText`), or '' when the
   * app does not get one. (webtty, ADR 049)
   */
  private encodeMouse(event: MouseEventReport): string {
    const px = this.cellPixelSize();
    if (!this.wasmTerm || !this.renderer || !this.canvas || !this.element || !px) return '';
    const metrics = this.renderer.getMetrics();
    const rect = this.canvas.getBoundingClientRect();
    const { geometry, x, y } = mouseSurface(
      event.clientX,
      event.clientY,
      {
        left: rect.left,
        // Viewport row 0 starts the scroll offset below the canvas top (ADR 043)
        top: rect.top + this.renderer.scrollOffset,
        cols: this.cols,
        rows: this.rows,
        cellWidth: metrics.width,
        cellHeight: metrics.height,
      },
      this.element.getBoundingClientRect(),
      px
    );
    this.wasmTerm.setMouseGeometry(geometry);
    const { clientX: _x, clientY: _y, ...input } = event;
    return mouseReportText(this.wasmTerm.encodeMouse({ ...input, x, y }));
  }

  /**
   * Input from the InputHandler. Keys and text clear the selection and scroll to the
   * bottom; a mouse report leaves both alone, so a Shift selection outlives the app's
   * hover and clicks. (webtty, ADR 051, ADR 055)
   */
  private handleInput = (data: string, mouseReport = false): void => {
    if (this.options.disableStdin) return;
    if (!mouseReport) {
      this.selectionManager?.clearSelection();
      // Ghostty's `scroll-to-bottom = keystroke`, which output no longer does while a
      // match is selected (webtty, ADR 055)
      this.scrollToBottom();
    }
    this.awaitingEcho = true;
    this.dataEmitter.fire(data);
  };

  private handleMenuPress = (e: MouseEvent): void => {
    this.menuSource.press(e);
  };

  private handleMenuKey = (): void => {
    this.menuSource.key();
  };

  /**
   * The one place a right-click or a keyboard menu is handled. A right button the app
   * takes (it tracks the mouse, Shift is up) is the app's: its press and release were
   * reported, and the menu is cancelled. Otherwise `rightClickBehavior` decides: the
   * browser menu, copy and clear the selection, paste, or nothing. (webtty: upstream
   * always showed the menu, from the selection manager, ADR 051)
   */
  private handleContextMenu = (e: MouseEvent): void => {
    const behavior = this.options.rightClickBehavior;
    const action = rightClickAction({
      tracking: this.wasmTerm?.hasMouseTracking() ?? false,
      shiftKey: e.shiftKey,
      fromKeyboard: this.menuSource.fromKeyboard(e),
      behavior,
      hasSelection: behavior === 'copyPaste' && this.getSelection() !== '',
    });
    if (action === 'menu') {
      this.selectionManager?.prepareContextMenu(e);
      return;
    }
    e.preventDefault();
    if (action === 'copy') {
      this.copySelection();
      this.clearSelection();
    } else if (action === 'paste') {
      this.pasteRequestEmitter.fire();
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
   * Check if mouse tracking is enabled
   */
  public hasMouseTracking(): boolean {
    this.assertOpen();
    return this.wasmTerm!.hasMouseTracking();
  }
}
