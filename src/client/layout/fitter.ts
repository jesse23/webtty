// Sizes the terminal grid to `#terminal` and places the padding around the canvas
// (service, ADR 033, ADR 042, ADR 060). Every resize signal goes through schedule(),
// which coalesces them into one fit per frame; font zoom calls fit() directly.

import { type Disposable, toDisposable } from '../vendor/ghostty-web';
import { computeInsets } from './fit-insets';
import { terminalCanvas } from './terminal-canvas';

/** The grid the fit addon proposes for the container, or undefined before the font is measured. */
export interface GridProposal {
  cols: number;
  rows: number;
}

/** What the fitter reads from and resizes: the vendored `Terminal` in production. */
export interface FitterHost {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  /** Sends the cell size in device pixels for Ghostty's size reports (ADR 042). */
  syncCellPixelSize(): void;
}

/** The grid size source, the vendored `FitAddon` in production. */
export interface GridSource {
  proposeDimensions(): GridProposal | undefined;
}

/** The frame scheduler the fitter coalesces on, the window's in production. */
export interface FitterDeps {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}

/** Fits the grid and the padding, and tells its hooks, in the order added, after each fit. */
export class Fitter implements Disposable {
  private pendingFrame: number | null = null;
  private readonly hooks: (() => void)[] = [];
  private disposed = false;

  constructor(
    private readonly term: FitterHost,
    private readonly container: HTMLElement,
    private readonly padding: number,
    private readonly grid: GridSource,
    private readonly deps: FitterDeps,
  ) {}

  /**
   * Runs `hook` after every fit that found the canvas, after the padding is placed: the
   * edge strips, then smooth scroll, which both read the new layout.
   */
  onFitted(hook: () => void): Disposable {
    this.hooks.push(hook);
    return toDisposable(() => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    });
  }

  /**
   * Fits now. FitAddon sizes the grid from the full container less its CSS padding, so
   * the padding is set to `padding` on every side first (#terminal is border-box, so
   * clientWidth/Height do not change). What is left over, plus `padding` on each side,
   * is then distributed: top and left are exactly `padding`, the leftover goes to the
   * right and bottom. proposeDimensions rather than FitAddon.fit(), which ignores calls
   * for 50 ms after each resize (ADR 033).
   */
  fit(): void {
    this.container.style.padding = `${this.padding}px`;
    const grid = this.grid.proposeDimensions();
    if (!grid) return;
    if (grid.cols !== this.term.cols || grid.rows !== this.term.rows) {
      this.term.resize(grid.cols, grid.rows);
    }
    // Every font zoom, font load and DPR change reaches fit(). A grid change has already
    // sent the new cell pixels with resize; this sends them when only the pixels
    // changed, for Ghostty's size reports (ADR 042).
    this.term.syncCellPixelSize();
    const canvas = terminalCanvas(this.container);
    if (!canvas) return;
    const insets = computeInsets(
      Math.max(0, this.container.clientWidth - canvas.offsetWidth),
      Math.max(0, this.container.clientHeight - canvas.offsetHeight),
      this.padding,
    );
    this.container.style.paddingLeft = `${insets.left}px`;
    this.container.style.paddingRight = `${insets.right}px`;
    this.container.style.paddingTop = `${insets.top}px`;
    this.container.style.paddingBottom = `${insets.bottom}px`;
    for (const hook of this.hooks) hook();
  }

  /**
   * Fits on the next frame. ResizeObserver and window `resize` can fire for the same
   * physical change, so the signals of one frame coalesce into one fit.
   */
  schedule(): void {
    if (this.disposed || this.pendingFrame !== null) return;
    this.pendingFrame = this.deps.requestAnimationFrame(() => {
      this.pendingFrame = null;
      this.fit();
    });
  }

  /** Cancels a scheduled fit and drops the hooks. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pendingFrame !== null) this.deps.cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = null;
    this.hooks.length = 0;
  }
}
