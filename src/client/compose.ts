/**
 * Shows IME / dictation composition text at the terminal cursor. See ADR 038.
 *
 * The vendored terminal keeps focus on its hidden textarea and anchors the textarea at
 * the cursor cell, so the OS dictation and candidate panels follow the cursor. The
 * textarea is clipped, so the composition itself is invisible; an overlay shows it over
 * the cursor cell in the theme's colours. Committed text still reaches the PTY through
 * ghostty-web's own compositionend handling.
 */

import type { Terminal } from './vendor/ghostty-web';

// ghostty-web's defaults for a theme without foreground/background.
const DEFAULT_FOREGROUND = '#d4d4d4';
const DEFAULT_BACKGROUND = '#1e1e1e';

export class Composer {
  private readonly overlay = document.createElement('div');
  private composing = false;
  private frame = 0;

  constructor(
    private readonly term: Terminal,
    private readonly container: HTMLElement,
    private readonly theme: { foreground?: string; background?: string },
  ) {
    const o = this.overlay;
    o.dataset.compose = 'true';
    o.style.position = 'absolute';
    o.style.display = 'none';
    o.style.pointerEvents = 'none';
    o.style.whiteSpace = 'pre';
    o.style.overflow = 'hidden';
    o.style.zIndex = '10';
    o.style.textDecoration = 'underline';
    container.append(o);

    container.addEventListener('compositionstart', this.onCompositionStart);
    container.addEventListener('compositionupdate', this.onCompositionUpdate);
    container.addEventListener('compositionend', this.onCompositionEnd);
    container.addEventListener('focusout', this.onCompositionEnd);
  }

  // The terminal has no per-frame cursor event, so the overlay follows the cursor
  // every frame while composing. setPx only writes
  // styles that changed.
  private readonly tick = (): void => {
    if (!this.composing) {
      this.frame = 0;
      return;
    }
    this.frame = window.requestAnimationFrame(this.tick);
    this.update();
  };

  /** Re-place the overlay over the cursor cell. */
  update(): void {
    const spot = this.term.getCursorCellOffset();
    if (spot) this.placeOverlay(spot);
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.update();
    if (!this.frame) this.frame = window.requestAnimationFrame(this.tick);
  };

  private readonly onCompositionUpdate = (e: CompositionEvent): void => {
    this.composing = true;
    if (!this.frame) this.frame = window.requestAnimationFrame(this.tick);
    const text = e.data ?? '';
    if (!text) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.textContent = text;
    this.update();
    this.overlay.style.display = 'block';
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.overlay.style.display = 'none';
    this.overlay.textContent = '';
  };

  private placeOverlay(spot: { left: number; top: number }): void {
    const o = this.overlay;
    const cell = this.cell();
    const canvas = this.terminalCanvas();
    const right = canvas ? canvas.offsetLeft + canvas.offsetWidth : spot.left;
    setPx(o, 'left', spot.left);
    setPx(o, 'top', spot.top);
    setPx(o, 'height', cell.height);
    setPx(o, 'lineHeight', cell.height);
    setPx(o, 'maxWidth', Math.max(cell.width, right - spot.left));
    o.style.fontFamily = this.term.options.fontFamily;
    o.style.fontSize = `${this.term.options.fontSize}px`;
    o.style.color = this.theme.foreground ?? DEFAULT_FOREGROUND;
    o.style.background = this.theme.background ?? DEFAULT_BACKGROUND;
  }

  private cell(): { width: number; height: number } {
    const metrics = this.term.renderer?.getMetrics();
    return { width: metrics?.width ?? 0, height: metrics?.height ?? 0 };
  }

  private terminalCanvas(): HTMLCanvasElement | null {
    return this.container.querySelector('canvas:not([data-edge])');
  }
}

function setPx(
  el: HTMLElement,
  prop: 'left' | 'top' | 'height' | 'lineHeight' | 'maxWidth',
  value: number,
): void {
  const px = `${value}px`;
  if (el.style[prop] !== px) el.style[prop] = px;
}
