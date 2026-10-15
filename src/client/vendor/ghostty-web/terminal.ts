// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal (facade): the xterm.js-compatible terminal over Ghostty's libghostty-vt engine,
// its emitters and the parts it composes in open(); webtty creates it with
// `new Terminal({ ghostty: await Ghostty.load(url), ... })` and `open(container)` (ADR 061).

import { BufferNamespace } from './buffer';
import { FindController } from './core/find-controller';
import { FocusTracker } from './core/focus-tracker';
import { MouseController } from './core/mouse-controller';
import { RenderLoop } from './core/render-loop';
import {
  SCROLLBAR_FADE_DURATION_MS,
  SCROLLBAR_HIDE_DELAY_MS,
} from './core/terminal-constants';
import {
  createOptionsProxy,
  type TerminalOptionValues,
  toEngineConfig,
  withDefaults,
} from './core/options-proxy';
import {
  cursorCellOffset,
  deviceCellPixels,
  mouseCursorFor,
  setStylePx,
} from './core/terminal-geometry';
import { Viewport } from './core/viewport';
import { WheelController } from './core/wheel-controller';
import { WritePipeline } from './core/write-pipeline';
import { EventEmitter } from './event-emitter';
import type {
  DesktopNotification,
  Ghostty,
  GhosttyCell,
  GhosttyTerminal,
  SearchState,
} from './ghostty';
import type { Pace } from './glide';
import { InputHandler, type MouseTrackingConfig } from './input-handler';
import type {
  IBufferNamespace,
  IEvent,
  ITerminalAddon,
  ITerminalCore,
  ITerminalOptions,
} from './interfaces';
import { LinkDetector } from './link-detector';
import { OSC8LinkProvider } from './providers/osc8-link-provider';
import { UrlRegexProvider } from './providers/url-regex-provider';
import { CanvasRenderer } from './renderer';
import {
  inScrollbarColumn,
  SCROLLBAR_PADDING,
  scrollbarThumbHeight,
  scrollbarThumbY,
  scrollbarTrackHeight,
} from './render/scrollbar-geometry';
import { SelectionManager } from './selection-manager';

// The facade's former contents, re-exported so deep imports keep working (ADR 061)
export { TERMINAL_DEFAULTS, toEngineConfig } from './core/options-proxy';
export {
  cursorCellOffset,
  deviceCellPixels,
  mouseCursorFor,
  mouseSurface,
} from './core/terminal-geometry';
export { mouseReportText } from './input/mouse-report';

/** The xterm.js-compatible terminal: webtty's one terminal per page. */
export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public element?: HTMLElement;
  public textarea?: HTMLTextAreaElement;

  // Buffer API (xterm.js compatibility)
  public readonly buffer: IBufferNamespace;

  // Options (public for xterm.js compatibility); a change after open() is applied
  public readonly options: TerminalOptionValues;

  // Components (created on open())
  private ghostty?: Ghostty;
  public wasmTerm?: GhosttyTerminal; // Made public for link providers
  public renderer?: CanvasRenderer; // Made public for FitAddon
  private inputHandler?: InputHandler;
  private selectionManager?: SelectionManager;
  private canvas?: HTMLCanvasElement;

  // Link detection system
  private linkDetector?: LinkDetector;

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

  // Addons
  private addons: ITerminalAddon[] = [];

  // The title last reported through onTitleChange
  private currentTitle: string = '';

  // Focus kept off the container and reported to the app under mode 1004 (webtty, ADR 053)
  private readonly focusTracker = new FocusTracker({
    element: () => this.element,
    textarea: () => this.textarea,
    engine: () => this.wasmTerm,
    disableStdin: () => this.options.disableStdin,
    send: (data) => this.dataEmitter.fire(data),
  });

  // Find in the scrollback, stepped by the render loop (webtty, ADR 055)
  private readonly finder = new FindController({
    engine: () => this.wasmTerm,
    highlight: (highlights) => this.renderer?.setSearchHighlights(highlights),
    getScrollbackLength: () => this.getScrollbackLength(),
    viewportY: () => this.viewportY,
    rows: () => this.rows,
    scrollToLine: (line) => this.scrollToLine(line),
    changed: (state) => this.findChangeEmitter.fire(state),
  });

  // Output into the engine and every step after it, in a fixed order (ADR 061)
  private readonly writes = new WritePipeline({
    engine: () => this.wasmTerm,
    disableStdin: () => this.options.disableStdin,
    send: (data) => this.dataEmitter.fire(data),
    followFocusMode: () => this.focusTracker.followMode(),
    bell: () => this.bellEmitter.fire(),
    title: (title) => this.setTitle(title),
    clipboardWrite: (text) => this.clipboardWriteEmitter.fire(text),
    notify: (notification) => this.desktopNotificationEmitter.fire(notification),
    outputChanged: () => this.linkDetector?.invalidateCache(),
    viewportY: () => this.viewportY,
    findAnchored: () => this.finder.anchored,
    scrollToBottom: () => this.scrollToBottom(),
    renderEcho: () => {
      if (this.renderer && this.wasmTerm) {
        this.renderer.render(this.wasmTerm, false, this.viewportY, this, this.scrollbarOpacity);
      }
    },
  });

  // One frame after another while open, each in a fixed order (ADR 061)
  private readonly renderLoop = new RenderLoop({
    live: () => !this.isDisposed && this.isOpen,
    beforeRender: (now) => this.beforeRender?.(now),
    stepFind: (now) => this.finder.step(now),
    render: () =>
      this.renderer!.render(this.wasmTerm!, false, this.viewportY, this, this.scrollbarOpacity),
    hasReplies: () => this.wasmTerm!.hasResponse(),
    drainReplies: () => this.writes.drainReplies(),
    anchorTextarea: () => this.anchorTextarea(),
  });

  // Where the view is in the scrollback; each move fires onScroll and shows the scrollbar
  private readonly viewport = new Viewport({
    getScrollbackLength: () => this.getScrollbackLength(),
    scrolled: (viewportY) => this.scrollEmitter.fire(viewportY),
    showScrollbar: () => this.showScrollbar(),
  });

  // Link hover and clicks, the mouse report encoder and the right-click route (ADR 049, ADR 051)
  private readonly mouse = new MouseController({
    element: () => this.element,
    canvas: () => this.canvas,
    engine: () => this.wasmTerm,
    renderer: () => this.renderer,
    links: () => this.linkDetector,
    selection: () => this.selectionManager,
    rows: () => this.rows,
    cols: () => this.cols,
    viewportY: () => this.getViewportY(),
    cellPixelSize: () => this.cellPixelSize(),
    rightClickBehavior: () => this.options.rightClickBehavior,
    dragScrollbar: (e) => {
      if (!this.isDraggingScrollbar) return false;
      this.processScrollbarDrag(e);
      return true;
    },
    requestPaste: () => this.pasteRequestEmitter.fire(),
  });

  // Wheel events to the embedder, or to the app as ticks or arrows (ADR 045, ADR 049)
  private readonly wheel = new WheelController({
    engine: () => this.wasmTerm,
    cellHeight: () => this.renderer?.getMetrics()?.height,
    hasCanvas: () => !!this.canvas,
    rows: () => this.rows,
    mouseScrollSpeed: () => this.options.mouseScrollSpeed,
    encodeMouse: (event) => this.mouse.encode(event),
    send: (data) => this.dataEmitter.fire(data),
  });
  private beforeRender?: (now: number) => void;

  // Scrollbar interaction state
  private isDraggingScrollbar: boolean = false;
  private scrollbarDragStart: number | null = null;
  private scrollbarDragStartViewportY: number = 0;

  // Scrollbar visibility/auto-hide state
  private scrollbarVisible: boolean = false;
  private scrollbarOpacity: number = 0;
  private scrollbarHideTimeout?: number;

  constructor(options: ITerminalOptions) {
    this.ghostty = options.ghostty;
    // Options set after open() are applied (xterm.js compatibility)
    this.options = createOptionsProxy(withDefaults(options), (key, value, oldValue) => {
      if (this.isOpen) this.handleOptionChange(key, value, oldValue);
    });

    this.cols = this.options.cols;
    this.rows = this.options.rows;

    // Initialize buffer API
    this.buffer = new BufferNamespace(this);
  }

  /**
   * Lines scrolled back from the bottom of the scrollback (0 = at the bottom); fractional
   * while smooth scrolling. Setting it moves the view without firing onScroll.
   */
  get viewportY(): number {
    return this.viewport.y;
  }

  set viewportY(y: number) {
    this.viewport.y = y;
  }

  /** Applies an option set after open(): the cursor, the font, or the grid size. */
  private handleOptionChange(
    key: keyof TerminalOptionValues,
    newValue: unknown,
    oldValue: unknown
  ): void {
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
      // Focus is followed, and kept on the textarea, by the focus tracker (webtty, ADR 053)
      this.focusTracker.attach(parent);

      // Add accessibility attributes for screen readers and extensions
      parent.setAttribute('role', 'textbox');
      parent.setAttribute('aria-label', 'Terminal input');
      parent.setAttribute('aria-multiline', 'true');

      // Create WASM terminal with current dimensions and config
      const config = toEngineConfig(this.options);
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
        encode: (event) => this.mouse.encode(event),
      };

      // Create input handler
      this.inputHandler = new InputHandler({
        ghostty: this.ghostty!,
        container: parent,
        onData: this.handleInput,
        // Query terminal mode state (e.g., mode 1 for application cursor mode)
        getMode: (mode: number) => this.wasmTerm?.getMode(mode, false) ?? false,
        // Handle Cmd+C copy - returns true if there was a selection to copy
        onCopy: () => this.copySelection(),
        inputElement: this.textarea,
        mouseConfig,
      });

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

      // Scrollbar clicks, in the capture phase to intercept them before SelectionManager
      parent.addEventListener('mousedown', this.handleMouseDown, { capture: true });
      // Link hover and clicks, then the right-click route (webtty, ADR 051)
      this.mouse.attach(parent);

      // Setup document-level mouseup for scrollbar drag (so drag works even outside canvas)
      document.addEventListener('mouseup', this.handleMouseUp);

      // Wheel events, in the capture phase before the browser scrolls
      this.wheel.attach(parent);

      // Render initial blank screen (force full redraw)
      this.renderer.render(this.wasmTerm, true, this.viewportY, this, this.scrollbarOpacity);

      // Start render loop
      this.renderLoop.start();

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
    this.writes.drainReplies();
  }

  /**
   * Finds `needle` in the scrollback and on screen with libghostty-vt's search, as
   * Ghostty's `search` action does: every match is highlighted, none selected. The
   * search runs in the render loop, a few milliseconds a frame. `''` ends it.
   * (webtty, ADR 055)
   */
  find(needle: string): void {
    this.finder.find(needle);
  }

  /** Ends the search and clears its highlights (Ghostty's `end_search`). */
  endFind(): void {
    this.find('');
  }

  /** Whether a search is open. */
  get finding(): boolean {
    return this.finder.finding;
  }

  /**
   * Selects the next match, toward older output (Ghostty's `navigate_search:next`), and
   * scrolls to it if none of its rows is in view. False with no search open.
   */
  findNext(): boolean {
    return this.finder.select('next');
  }

  /** Selects the previous match, toward newer output. False with no search open. */
  findPrevious(): boolean {
    return this.finder.select('previous');
  }

  /**
   * Ghostty's `jump_to_prompt`: moves the view by `delta` OSC 133 prompts (negative is
   * up), a prompt landing as the top row; nothing without marks or past the last one.
   * (webtty, ADR 057)
   */
  jumpToPrompt(delta: number): void {
    if (!this.wasmTerm) return;
    const scrollback = this.getScrollbackLength();
    const top = scrollback - Math.floor(this.viewportY);
    const row = this.wasmTerm.promptJumpRow(top, delta);
    if (row !== top) this.scrollToLine(scrollback - row);
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
    this.writes.clearAtGround();
    return true;
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

    this.writes.write(data, callback);
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
    this.renderLoop.cancel();

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
      this.writes.drainReplies();

      // Force full render, the scrollbar at its current opacity (webtty, ADR 043)
      this.renderer!.render(this.wasmTerm!, true, this.viewportY, this, this.scrollbarOpacity);
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }

    this.renderLoop.start();
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
    this.writes.drainReplies();
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
    const config = toEngineConfig(this.options);
    this.wasmTerm = this.ghostty!.createTerminal(this.cols, this.rows, config);
    this.syncCellPixelSize();

    // Clear renderer
    this.renderer!.clear();

    // Reset title
    this.currentTitle = '';
    // The new engine starts with mode 1004 off (webtty, ADR 053)
    this.focusTracker.reset();
    // A clear waiting for the old engine's output is not for the new one (webtty, ADR 054)
    this.writes.reset();
    // A search goes on in the new engine (webtty, ADR 055)
    this.finder.restart();
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
   * Get the current viewport Y position.
   *
   * This is the number of lines scrolled back from the bottom of the
   * scrollback buffer. It may be fractional during smooth scrolling.
   */
  public getViewportY(): number {
    return this.viewportY;
  }

  /**
   * Attach a custom wheel event handler
   * Returns true to prevent default handling
   */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean
  ): void {
    this.wheel.setCustomHandler(customWheelEventHandler);
  }

  /**
   * Sets how to pace the scroll ticks of a wheel event sent to the app (mouse
   * tracking, or arrow keys on the alternate screen); without it they go at once.
   * Called once for each such event. (webtty, ADR 045)
   */
  public attachWheelPace(pace?: (event: WheelEvent) => Pace): void {
    this.wheel.setPace(pace);
  }

  /**
   * Runs `callback` in every frame of the render loop, just before it renders, so
   * an animation that moves the viewport shows in the same frame. (webtty, ADR 045)
   */
  public attachBeforeRender(callback?: (now: number) => void): void {
    this.beforeRender = callback;
  }

  /**
   * Scroll viewport by a number of lines
   * @param amount Number of lines to scroll (positive = down, negative = up)
   */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) {
      throw new Error('Terminal not open');
    }
    this.viewport.scrollLines(amount);
  }

  /** Scroll viewport to the bottom (current output) */
  public scrollToBottom(): void {
    this.viewport.scrollToBottom();
  }

  /**
   * Scroll viewport to a specific line in the buffer
   * @param line Lines back from the bottom (0 = the bottom, scrollbackLength = the top)
   */
  public scrollToLine(line: number): void {
    this.viewport.scrollToLine(line);
  }

  /**
   * Dispose terminal and clean up resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    this.isOpen = false;

    // Stop render loop
    this.renderLoop.cancel();

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

  /**
   * Sends the current focus if mode 1004 is on, for a new connection to the app: reports
   * sent while there was none were dropped. (webtty, ADR 053)
   */
  resyncFocus(): void {
    this.focusTracker.resync();
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

    // Remove event listeners; the wheel's queued ticks and the mouse's throttled move go
    // with theirs
    this.wheel.dispose();
    this.mouse.dispose();
    if (this.element) {
      this.element.removeEventListener('mousedown', this.handleMouseDown, { capture: true });
      this.focusTracker.dispose();

      // Remove contenteditable and accessibility attributes added in open()
      this.element.removeAttribute('contenteditable');
      this.element.removeAttribute('role');
      this.element.removeAttribute('aria-label');
      this.element.removeAttribute('aria-multiline');
    }

    // Remove document-level listeners (only if opened)
    if (this.isOpen && typeof document !== 'undefined') {
      document.removeEventListener('mouseup', this.handleMouseUp);
      this.focusTracker.detachWindow();
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
    this.writes.awaitEcho();
    this.dataEmitter.fire(data);
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

    // Check if click is in scrollbar area: the renderer's geometry, in the rect's CSS pixels
    if (inScrollbarColumn(mouseX, rect.width)) {
      // Prevent default and stop propagation to prevent text selection
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation(); // Stop SelectionManager from seeing this event

      // Calculate scrollbar thumb position and size
      const trackHeight = scrollbarTrackHeight(rect.height);
      const thumbHeight = scrollbarThumbHeight(this.rows, scrollbackLength, trackHeight);
      const thumbY = scrollbarThumbY(this.viewportY, scrollbackLength, trackHeight, thumbHeight);

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
        const relativeY = mouseY - SCROLLBAR_PADDING;
        const scrollFraction = 1 - relativeY / trackHeight; // Inverted: top = 1, bottom = 0
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
    const trackHeight = scrollbarTrackHeight(rect.height);
    const thumbHeight = scrollbarThumbHeight(this.rows, scrollbackLength, trackHeight);

    // Calculate scroll fraction from thumb movement
    // Note: thumb moves in opposite direction to viewport (thumb down = scroll down = viewportY decreases)
    const scrollFraction = -deltaY / (trackHeight - thumbHeight);
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
      }, SCROLLBAR_HIDE_DELAY_MS);
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
      const progress = Math.min(elapsed / SCROLLBAR_FADE_DURATION_MS, 1);
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
      const progress = Math.min(elapsed / SCROLLBAR_FADE_DURATION_MS, 1);
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

  /** Fires onTitleChange when the title differs from the current one. */
  private setTitle(title: string): void {
    if (title === this.currentTitle) return;
    this.currentTitle = title;
    this.titleChangeEmitter.fire(title);
  }

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
