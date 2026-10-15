// The canvas kitty images are drawn on, laid over the terminal's own (view, ADR 032): it
// repaints on the frame after anything changed, follows the terminal's scroll, size and
// pixel ratio, holds while the app sends a synchronized update (ADR 067), and frees its
// backing store while there is nothing to draw.

import { TERMINAL_CANVAS_UNDER_OVERLAY, terminalCanvas } from '../../../layout/terminal-canvas';
import { DisposableStore, listen, toDisposable } from '../../../vendor/ghostty-web';
import {
  type CellSize,
  cellSize,
  type KittyTerminal,
  scrollbackLength,
  scrollOffset,
} from './kitty-terminal';
import { drawRect } from './placement-geometry';
import type { Placement } from './placements';

/** What the overlay draws: the placements and the bitmaps of their images. */
export interface OverlaySource {
  readonly placements: { readonly size: number; values(): Iterable<Placement> };
  /** An image's bitmap, undefined while its first decode is still running. */
  readonly images: { bitmapOf(imageId: number): ImageBitmap | undefined };
}

/** The browser objects the overlay is built in and repaints with. */
export interface OverlayDeps {
  document: Document;
  window: Pick<Window, 'devicePixelRatio' | 'requestAnimationFrame' | 'cancelAnimationFrame'>;
}

/** The overlay canvas, repainted from an animation-frame loop that runs until `dispose()`. */
export class OverlayCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly store = new DisposableStore();
  private frame = 0;
  private dirty = false;
  private lastSignature = '';

  constructor(
    private readonly term: KittyTerminal,
    private readonly container: HTMLElement,
    private readonly source: OverlaySource,
    private readonly deps: OverlayDeps,
  ) {
    const canvas = deps.document.createElement('canvas');
    this.canvas = canvas;
    canvas.dataset.kitty = '';
    // A new canvas is 300x150, which the tick reads as something to draw. At
    // 0x0 the overlay holds no backing store and costs no layout read per
    // frame until an image is placed.
    canvas.width = 0;
    canvas.height = 0;
    canvas.style.cssText = 'position:absolute;pointer-events:none;';
    container.appendChild(canvas);
    this.store.add(toDisposable(() => canvas.remove()));
    this.frame = deps.window.requestAnimationFrame(this.tick);
    this.store.add(toDisposable(() => deps.window.cancelAnimationFrame(this.frame)));
    // Chromium can discard a canvas's contents while its tab is hidden. The
    // overlay's geometry does not change when the tab comes back, so nothing
    // else would make it repaint.
    this.store.add(
      listen(deps.document, 'visibilitychange', () => {
        if (deps.document.visibilityState === 'visible') this.invalidate();
      }),
    );
  }

  /** Repaint on the next frame: placements or bitmaps changed. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Repaint the overlay on the next frame, whatever has or has not changed. */
  invalidate(): void {
    this.dirty = true;
    this.lastSignature = '';
  }

  /** Stops the frame loop, removes the listener and the canvas. Idempotent. */
  dispose(): void {
    this.store.dispose();
  }

  private readonly tick = (now: number): void => {
    this.frame = this.deps.window.requestAnimationFrame(this.tick);
    if (this.source.placements.size === 0 && !this.canvas.width) return;
    // An app that redraws its images deletes every placement and places them again in
    // one synchronized update; painting in between would blink them (ADR 067).
    if (this.term.renderHeld?.(now)) return;
    const canvas = terminalCanvas(this.container, TERMINAL_CANVAS_UNDER_OVERLAY);
    if (!canvas) return;
    const cell = cellSize(this.term);
    const signature = [
      scrollbackLength(this.term),
      this.term.viewportY,
      scrollOffset(this.term),
      cell.width,
      cell.height,
      canvas.offsetLeft,
      canvas.offsetTop,
      canvas.offsetWidth,
      canvas.offsetHeight,
      this.deps.window.devicePixelRatio,
    ].join('|');
    if (!this.dirty && signature === this.lastSignature) return;
    this.dirty = false;
    this.lastSignature = signature;
    this.draw(canvas, cell);
  };

  private draw(canvas: HTMLCanvasElement, cell: CellSize): void {
    const dpr = this.deps.window.devicePixelRatio || 1;
    const w = canvas.offsetWidth;
    const h = canvas.offsetHeight;
    const o = this.canvas;
    if (this.source.placements.size === 0) {
      // Nothing left to draw: free the backing store, which at full size is
      // the size of the terminal's canvas, and let the tick go idle.
      o.width = 0;
      o.height = 0;
      return;
    }
    if (o.width !== Math.round(w * dpr) || o.height !== Math.round(h * dpr)) {
      o.width = Math.round(w * dpr);
      o.height = Math.round(h * dpr);
    }
    o.style.left = `${canvas.offsetLeft}px`;
    o.style.top = `${canvas.offsetTop}px`;
    o.style.width = `${w}px`;
    o.style.height = `${h}px`;

    const ctx = o.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const topRow = scrollbackLength(this.term) - this.term.viewportY;
    const offset = scrollOffset(this.term);
    for (const p of this.source.placements.values()) {
      const img = this.source.images.bitmapOf(p.imageId);
      if (!img) continue;
      const r = drawRect(p, img, cell, topRow, offset);
      if (r.y + r.dh < 0 || r.y > h || r.x + r.dw < 0 || r.x > w) continue;
      ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, r.x, r.y, r.dw, r.dh);
    }
  }
}
