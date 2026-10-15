// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Terminal (facade): the xterm.js-compatible terminal over Ghostty's libghostty-vt engine,
// its emitters and the parts it composes in open(); webtty creates it with
// `new Terminal({ ghostty: await Ghostty.load(url), ... })` and `open(container)` (ADR 061).

import { BufferNamespace } from './buffer';
import {
  anchorTextarea,
  createInputTextarea,
  createTerminalCanvas,
  focusTextareaOnPress,
  labelContainer,
  makeContainerEditable,
  sizeCanvasElement,
  unlabelContainer,
} from './core/dom-setup';
import { disposeParts, type OpenedParts, type PartsMade } from './core/opened-parts';
import { applyOptionChange, type OptionChangeHost } from './core/option-changes';
import {
  createOptionsProxy,
  rendererOptions,
  type TerminalOptionValues,
  toEngineConfig,
  withDefaults,
} from './core/options-proxy';
import { TerminalControllers } from './core/terminal-controllers';
import { TerminalEmitters } from './core/terminal-emitters';
import { cellDevicePixels, cursorCellOffset } from './core/terminal-geometry';
import type {
  DesktopNotification,
  Ghostty,
  GhosttyCell,
  GhosttyTerminal,
  SearchState,
} from './ghostty';
import type { Pace } from './glide';
import { InputHandler } from './input-handler';
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

/** The parts with their classes, for the facade's own calls and its public getters. */
type TerminalParts = OpenedParts<CanvasRenderer, InputHandler, SelectionManager, LinkDetector>;

/** The xterm.js-compatible terminal: webtty's one terminal per page. */
export class Terminal implements ITerminalCore {
  // Public properties (xterm.js compatibility)
  public cols: number;
  public rows: number;
  public readonly buffer: IBufferNamespace;
  /** The options; a change after open() is applied (xterm.js compatibility). */
  public readonly options: TerminalOptionValues;

  private ghostty?: Ghostty;
  private parts?: TerminalParts;
  private isOpen = false;
  private isDisposed = false;
  private addons: ITerminalAddon[] = [];
  // The title last reported through onTitleChange
  private currentTitle = '';
  private beforeRender?: (now: number) => void;

  private readonly emit = new TerminalEmitters();
  // Public event accessors (xterm.js compatibility)
  public readonly onData: IEvent<string> = this.emit.data.event;
  public readonly onResize: IEvent<{ cols: number; rows: number }> = this.emit.resize.event;
  public readonly onBell: IEvent<void> = this.emit.bell.event;
  public readonly onTitleChange: IEvent<string> = this.emit.titleChange.event;
  public readonly onScroll: IEvent<number> = this.emit.scroll.event;
  /**
   * A right-click asks to paste the clipboard (`rightClickBehavior: "paste"`). The
   * embedder reads the clipboard, as for Ctrl+V. (webtty, ADR 051)
   */
  public readonly onPasteRequest: IEvent<void> = this.emit.pasteRequest.event;
  /**
   * The program wrote the clipboard (OSC 52, OSC 1337 Copy, OSC 5522), with the text to
   * write, `''` to clear it. Fires only while the `clipboardWrite` option is on; the
   * embedder writes the browser clipboard. (webtty, ADR 052)
   */
  public readonly onClipboardWrite: IEvent<string> = this.emit.clipboardWrite.event;
  /**
   * The program asked for a desktop notification (OSC 9, OSC 777 `notify`), with its
   * title (`''` for none) and body as plain text. Fires only while the
   * `desktopNotifications` option is on; the embedder shows it. (webtty, ADR 056)
   */
  public readonly onDesktopNotification: IEvent<DesktopNotification> =
    this.emit.desktopNotification.event;
  /** The match count or the selected match changed (webtty, ADR 055) */
  public readonly onFindChange: IEvent<SearchState> = this.emit.findChange.event;

  // Focus, find, writes, the render loop, the view, the scrollbar, the mouse and the wheel
  private readonly core = new TerminalControllers(this, {
    emit: this.emit,
    parts: () => this.parts,
    live: () => !this.isDisposed && this.isOpen,
    beforeRender: (now) => this.beforeRender?.(now),
    setTitle: (title) => this.setTitle(title),
    render: (force, opacity) => this.renderFrame(force, opacity),
    anchorTextarea: () => this.anchorTextarea(),
    cellPixelSize: () => this.cellPixelSize(),
  });

  // What an option set after open() reaches
  private readonly optionChangeHost: OptionChangeHost = {
    options: () => this.options,
    engine: () => this.wasmTerm,
    renderer: () => this.renderer,
    fontChanged: () => this.handleFontChange(),
    resize: (cols, rows) => this.resize(cols, rows),
  };

  constructor(options: ITerminalOptions) {
    this.ghostty = options.ghostty;
    // Options set after open() are applied (xterm.js compatibility)
    this.options = createOptionsProxy(withDefaults(options), (key, value, oldValue) => {
      if (this.isOpen) applyOptionChange(key, value, oldValue, this.optionChangeHost);
    });
    this.cols = this.options.cols;
    this.rows = this.options.rows;
    this.buffer = new BufferNamespace(this);
  }

  /** The container open() was given; undefined before it and after dispose(). */
  get element(): HTMLElement | undefined {
    return this.parts?.element;
  }

  /** The hidden textarea keyboard input goes to; undefined before open(). */
  get textarea(): HTMLTextAreaElement | undefined {
    return this.parts?.textarea;
  }

  /** The engine, public for the link providers, the buffer API and webtty's features. */
  get wasmTerm(): GhosttyTerminal | undefined {
    return this.parts?.engine;
  }

  /** The renderer, public for FitAddon and webtty's features. */
  get renderer(): CanvasRenderer | undefined {
    return this.parts?.renderer;
  }

  /**
   * Lines scrolled back from the bottom of the scrollback (0 = at the bottom); fractional
   * while smooth scrolling. Setting it moves the view without firing onScroll.
   */
  get viewportY(): number {
    return this.core.viewport.y;
  }

  set viewportY(y: number) {
    this.core.viewport.y = y;
  }

  /**
   * After a font change: the selection's pixels are stale, so it is cleared; the canvas
   * takes the new cell size and every row is drawn again.
   */
  private handleFontChange(): void {
    const parts = this.parts;
    if (!parts) return;
    parts.selection.clearSelection();
    parts.renderer.resize(this.cols, this.rows);
    sizeCanvasElement(parts.canvas, parts.renderer.getMetrics(), this.cols, this.rows);
    // The scrollbar at its current opacity: a frame that drops it repaints every row
    // (webtty, ADR 043)
    this.renderFrame(true);
  }

  /**
   * Opens the terminal in `parent`: builds its parts, adds the listeners in their fixed
   * order, renders the first frame and starts the render loop. The engine comes from the
   * Ghostty instance given to the constructor.
   */
  open(parent: HTMLElement): void {
    if (this.isOpen) throw new Error('Terminal is already open');
    if (this.isDisposed) throw new Error('Terminal has been disposed');
    this.isOpen = true;
    const made: PartsMade<TerminalParts> = { element: parent };
    try {
      const parts = this.createParts(parent, made);
      this.parts = parts;
      this.core.attach(parent, document);
      this.renderFrame(true);
      this.core.renderLoop.start();
      this.focus();
    } catch (error) {
      this.isOpen = false;
      this.cleanupComponents(this.parts ?? made);
      throw new Error(`Failed to open terminal: ${error}`);
    }
  }

  /**
   * Builds the DOM, the engine, the renderer, input, selection and links, in the order
   * open() has always made them (their listeners' order depends on it). Each part is noted
   * in `made` as it exists, so a failure part way cleans up what was made.
   */
  private createParts(parent: HTMLElement, made: PartsMade<TerminalParts>): TerminalParts {
    makeContainerEditable(parent);
    // Focus is followed, and kept on the textarea, by the focus tracker (webtty, ADR 053)
    this.core.focus.attach(parent);
    labelContainer(parent);
    const engine = this.ghostty!.createTerminal(this.cols, this.rows, toEngineConfig(this.options));
    made.engine = engine;
    const canvas = createTerminalCanvas(document);
    made.canvas = canvas;
    parent.appendChild(canvas);
    const textarea = createInputTextarea(document);
    made.textarea = textarea;
    parent.appendChild(textarea);
    focusTextareaOnPress(canvas, textarea);
    const renderer = new CanvasRenderer(canvas, rendererOptions(this.options));
    made.renderer = renderer;
    // Sized with the renderer's resize, for its device-pixel scaling
    renderer.resize(this.cols, this.rows);
    // Cell pixels for Ghostty's size reports, before the first write, so a reply never
    // says 0 px. Mode 2048 cannot be on yet, so there is no reply to drain. (webtty, ADR 042)
    const px = cellDevicePixels(renderer.getMetrics());
    engine.setCellPixelSize(px.width, px.height);
    const input = new InputHandler({
      ghostty: this.ghostty!,
      container: parent,
      onData: (data, mouseReport) => this.core.input(data, mouseReport),
      // Application cursor mode and the like, read from the engine as each key arrives
      getMode: (mode: number) => this.wasmTerm?.getMode(mode, false) ?? false,
      // Cmd+C copies the selection; true when there was one
      onCopy: () => this.copySelection(),
      inputElement: textarea,
      // Reports are encoded by Ghostty (webtty, ADR 049)
      mouseConfig: {
        hasMouseTracking: () => this.wasmTerm?.hasMouseTracking() ?? false,
        encode: (event) => this.core.mouse.encode(event),
      },
    });
    made.input = input;
    const selection = new SelectionManager(this, renderer, engine, textarea);
    made.selection = selection;
    renderer.setSelectionManager(selection);
    const links = new LinkDetector(this);
    made.links = links;
    // OSC 8 hyperlinks take precedence over plain-text URLs
    links.registerProvider(new OSC8LinkProvider(this));
    links.registerProvider(new UrlRegexProvider(this));
    return { element: parent, engine, canvas, textarea, renderer, input, selection, links };
  }

  /**
   * Pastes text as Ghostty does (`ghostty_terminal_paste`): bracketed while the app has
   * mode 2004 on, unsafe control bytes replaced with spaces, and newlines sent as CR
   * without 2004. The bytes go out through onData. (webtty: upstream bracketed the text
   * as it was, and only with 2004 on; ADR 049)
   */
  paste(text: string): void {
    const parts = this.openParts();
    if (this.options.disableStdin) return;
    // Ghostty always scrolls to the bottom on a paste (webtty, ADR 055)
    this.scrollToBottom();
    parts.engine.paste(text);
    this.core.writes.drainReplies();
  }

  /**
   * Finds `needle` in the scrollback and on screen with libghostty-vt's search, as
   * Ghostty's `search` action does: every match is highlighted, none selected. The
   * search runs in the render loop, a few milliseconds a frame. `''` ends it.
   * (webtty, ADR 055)
   */
  find(needle: string): void {
    this.core.finder.find(needle);
  }

  /** Ends the search and clears its highlights (Ghostty's `end_search`). */
  endFind(): void {
    this.find('');
  }

  /** Whether a search is open. */
  get finding(): boolean {
    return this.core.finder.finding;
  }

  /**
   * Selects the next match, toward older output (Ghostty's `navigate_search:next`), and
   * scrolls to it if none of its rows is in view. False with no search open.
   */
  findNext(): boolean {
    return this.core.finder.select('next');
  }

  /** Selects the previous match, toward newer output. False with no search open. */
  findPrevious(): boolean {
    return this.core.finder.select('previous');
  }

  /**
   * Ghostty's `jump_to_prompt`: moves the view by `delta` OSC 133 prompts (negative is
   * up), a prompt landing as the top row; nothing without marks or past the last one.
   * (webtty, ADR 057)
   */
  jumpToPrompt(delta: number): void {
    const engine = this.wasmTerm;
    if (engine) this.core.viewport.jumpToPrompt(delta, engine);
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
    if (this.openParts().engine.isAlternateScreen()) return false;
    this.clearSelection();
    this.core.writes.clearAtGround();
    return true;
  }

  /** Writes output to the terminal; `callback` runs on the next frame, after its render. */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.openParts();
    if (this.options.convertEol && typeof data === 'string') data = data.replace(/\n/g, '\r\n');
    this.core.writes.write(data, callback);
  }

  /** Resizes the grid, the engine and the canvas, fires onResize and renders every row. */
  resize(cols: number, rows: number): void {
    const parts = this.openParts();
    if (cols === this.cols && rows === this.rows) return;
    // The loop stops while the engine reallocates its buffers, which detaches the typed
    // array views a frame reads, and starts again after. A flag cleared by an animation
    // frame would stall in background tabs, where frames are throttled.
    this.core.renderLoop.cancel();
    try {
      this.cols = cols;
      this.rows = rows;
      // The device-pixel cell size goes in the same call, so a change of grid and pixels
      // is one size report. (webtty, ADR 042)
      const px = this.cellPixelSize();
      parts.engine.resize(cols, rows, px?.width, px?.height);
      parts.renderer.resize(cols, rows);
      sizeCanvasElement(parts.canvas, parts.renderer.getMetrics(), cols, rows);
      this.emit.resize.fire({ cols, rows });
      // A mode 2048 size report from the resize, sent after the PTY resize message
      // (webtty, ADR 042)
      this.core.writes.drainReplies();
      // Every row, the scrollbar at its current opacity (webtty, ADR 043)
      this.renderFrame(true);
    } catch (e) {
      console.error('Terminal resize failed:', e);
    }
    this.core.renderLoop.start();
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
    this.core.writes.drainReplies();
  }

  /** The renderer's cell in whole device pixels, or null before open(). (webtty) */
  private cellPixelSize(): { width: number; height: number } | null {
    return this.renderer ? cellDevicePixels(this.renderer.getMetrics()) : null;
  }

  /** Starts over on a new engine: the title, focus reports and a waiting clear reset. */
  reset(): void {
    const parts = this.openParts();
    parts.engine.free();
    parts.engine = this.ghostty!.createTerminal(this.cols, this.rows, toEngineConfig(this.options));
    this.syncCellPixelSize();
    parts.renderer.clear();
    this.currentTitle = '';
    // The new engine starts with mode 1004 off (webtty, ADR 053)
    this.core.focus.reset();
    // A clear waiting for the old engine's output is not for the new one (webtty, ADR 054)
    this.core.writes.reset();
    // A search goes on in the new engine (webtty, ADR 055)
    this.core.finder.restart();
  }

  /**
   * Focuses the terminal for keyboard and wheel input, now and once more after the DOM
   * settles, which some browsers need for the focus to stick.
   */
  focus(): void {
    if (!this.isOpen || !this.element) return;
    this.element.focus();
    setTimeout(() => this.element?.focus(), 0);
  }

  /** Activates an addon; dispose() disposes it. */
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(this);
    this.addons.push(addon);
  }

  /** The selected text, or '' with none. */
  public getSelection(): string {
    return this.parts?.selection.getSelection() || '';
  }

  /** Clears the selection. */
  public clearSelection(): void {
    this.parts?.selection.clearSelection();
  }

  /** Copies the selection to the clipboard; true when there was text to copy. */
  public copySelection(): boolean {
    return this.parts?.selection.copySelection() || false;
  }

  /** viewportY, as a method (xterm.js compatibility). */
  public getViewportY(): number {
    return this.viewportY;
  }

  /** Sets the embedder's wheel handler; when it returns true, the terminal does nothing. */
  public attachCustomWheelEventHandler(
    customWheelEventHandler?: (event: WheelEvent) => boolean,
  ): void {
    this.core.wheel.setCustomHandler(customWheelEventHandler);
  }

  /**
   * Sets how to pace the scroll ticks of a wheel event sent to the app (mouse
   * tracking, or arrow keys on the alternate screen); without it they go at once.
   * Called once for each such event. (webtty, ADR 045)
   */
  public attachWheelPace(pace?: (event: WheelEvent) => Pace): void {
    this.core.wheel.setPace(pace);
  }

  /**
   * Runs `callback` in every frame of the render loop, just before it renders, so
   * an animation that moves the viewport shows in the same frame. (webtty, ADR 045)
   */
  public attachBeforeRender(callback?: (now: number) => void): void {
    this.beforeRender = callback;
  }

  /** Scrolls the view by `amount` lines: positive is down, negative up into history. */
  public scrollLines(amount: number): void {
    if (!this.wasmTerm) throw new Error('Terminal not open');
    this.core.viewport.scrollLines(amount);
  }

  /** Scrolls the view to the bottom, the current output. */
  public scrollToBottom(): void {
    this.core.viewport.scrollToBottom();
  }

  /** Scrolls the view to `line` lines back from the bottom (the scrollback length is the top). */
  public scrollToLine(line: number): void {
    this.core.viewport.scrollToLine(line);
  }

  /** Disposes the addons, the parts and the emitters. Calling it again does nothing. */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.isOpen = false;
    this.core.renderLoop.cancel();
    for (const addon of this.addons) addon.dispose();
    this.addons = [];
    this.cleanupComponents(this.parts);
    this.emit.dispose();
  }

  /**
   * Sends the current focus if mode 1004 is on, for a new connection to the app: reports
   * sent while there was none were dropped. (webtty, ADR 053)
   */
  resyncFocus(): void {
    this.core.focus.resync();
  }

  /**
   * The cursor cell's top-left corner in CSS pixels relative to the container's
   * padding box, or undefined before open(). (webtty)
   */
  getCursorCellOffset(): { left: number; top: number } | undefined {
    const parts = this.parts;
    if (!parts) return undefined;
    return cursorCellOffset(
      parts.engine.getCursor(),
      this.viewportY,
      { cols: this.cols, rows: this.rows },
      parts.renderer.getMetrics(),
      { left: parts.canvas.offsetLeft, top: parts.canvas.offsetTop },
    );
  }

  /** Keeps the input textarea on the cursor cell, for the IME and dictation (webtty). */
  private anchorTextarea(): void {
    const parts = this.parts;
    const spot = this.getCursorCellOffset();
    if (!parts || !spot) return;
    anchorTextarea(parts.textarea, spot, parts.renderer.getMetrics().height);
  }

  /** A scrollback line's cells, `offset` lines from its top (IScrollbackProvider). */
  public getScrollbackLine(offset: number): GhosttyCell[] | null {
    return this.wasmTerm?.getScrollbackLine(offset) ?? null;
  }

  /** The number of scrollback lines, 0 before open() (IScrollbackProvider). */
  public getScrollbackLength(): number {
    return this.wasmTerm?.getScrollbackLength() ?? 0;
  }

  /** A scrollback cell's whole grapheme (IScrollbackProvider). */
  public getScrollbackGraphemeString(offset: number, col: number): string {
    return this.wasmTerm?.getScrollbackGraphemeString(offset, col) ?? ' ';
  }

  /**
   * Takes down what open() made, on dispose or after a failed open(): `parts` may be
   * partial. The listeners marked as leaking in the listener snapshot stay (ADR 065).
   */
  private cleanupComponents(parts: Partial<OpenedParts> | undefined): void {
    this.core.detach();
    if (parts?.element) {
      this.core.focus.dispose();
      unlabelContainer(parts.element);
    }
    // Never true here: both callers clear isOpen first (ADR 065)
    if (this.isOpen && typeof document !== 'undefined') {
      this.core.scrollbar.unwatchRelease();
      this.core.focus.detachWindow();
    }
    if (parts) disposeParts(parts);
    this.parts = undefined;
    this.ghostty = undefined;
  }

  /** The parts of an open terminal; throws before open() and after dispose(). */
  private openParts(): TerminalParts {
    if (this.isDisposed) throw new Error('Terminal has been disposed');
    if (!this.isOpen || !this.parts) {
      throw new Error('Terminal must be opened before use. Call terminal.open(parent) first.');
    }
    return this.parts;
  }

  /**
   * Renders the current view now, if open, with the scrollbar at `opacity` (its current
   * one by default); `force` repaints every row.
   */
  private renderFrame(force: boolean, opacity = this.core.scrollbar.opacity): void {
    const parts = this.parts;
    if (parts) parts.renderer.render(parts.engine, force, this.viewportY, this, opacity);
  }

  /** Fires onTitleChange when the title differs from the current one. */
  private setTitle(title: string): void {
    if (title === this.currentTitle) return;
    this.currentTitle = title;
    this.emit.titleChange.fire(title);
  }

  /** Whether a mode is on: `isAnsi` for an ANSI mode, else DEC private (2004: bracketed paste). */
  public getMode(mode: number, isAnsi: boolean = false): boolean {
    return this.openParts().engine.getMode(mode, isAnsi);
  }

  /** Whether the app tracks the mouse. */
  public hasMouseTracking(): boolean {
    return this.openParts().engine.hasMouseTracking();
  }
}
