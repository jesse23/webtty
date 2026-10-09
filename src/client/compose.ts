/**
 * Shows IME / dictation composition text at the terminal cursor. See ADR 038.
 *
 * ghostty-web makes the container `contenteditable` and reads input from a hidden
 * textarea. When the container itself holds focus (a click in the padding, tab focus),
 * the browser writes the uncommitted composition into the container as a text node: a
 * stray line under the canvas in the page's default colours. When the textarea holds
 * focus, the composition is invisible and the OS panels anchor to its spot at the
 * top-left corner.
 *
 * So focus is kept on the textarea, the textarea follows the cursor cell (the OS places
 * the dictation and candidate panels by its caret), and an overlay shows the composition
 * over the cursor cell in the theme's colours. Committed text still reaches the PTY
 * through ghostty-web's own compositionend handling.
 */

import type { Terminal } from 'ghostty-web';

// ghostty-web's defaults for a theme without foreground/background.
const DEFAULT_FOREGROUND = '#d4d4d4';
const DEFAULT_BACKGROUND = '#1e1e1e';

export interface CursorSpot {
  left: number;
  top: number;
}

/**
 * The cursor cell's top-left corner, in CSS pixels relative to the container's padding
 * box. `cursorY` is relative to the bottom screen; when scrolled back by `viewportY`
 * lines the cursor moves down by that many rows, and it is kept on the last visible row
 * once it scrolls out of view.
 */
export function computeCursorSpot(
  cursor: { x: number; y: number },
  viewportY: number,
  grid: { cols: number; rows: number },
  cell: { width: number; height: number },
  canvas: { left: number; top: number },
): CursorSpot {
  const col = Math.min(Math.max(0, cursor.x), Math.max(0, grid.cols - 1));
  const row = Math.min(Math.max(0, cursor.y + Math.floor(viewportY)), Math.max(0, grid.rows - 1));
  return {
    left: canvas.left + col * cell.width,
    top: canvas.top + row * cell.height,
  };
}

export class Composer {
  private readonly overlay = document.createElement('div');
  private composing = false;

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

    container.addEventListener('focusin', this.onFocusIn);
    // focus() on a background window moves activeElement without a focusin; catch the
    // container still holding focus when the window comes back.
    window.addEventListener('focus', () => {
      if (document.activeElement === container) this.term.textarea?.focus();
    });
    container.addEventListener('compositionstart', this.onCompositionStart);
    container.addEventListener('compositionupdate', this.onCompositionUpdate);
    container.addEventListener('compositionend', this.onCompositionEnd);
    container.addEventListener('focusout', this.onCompositionEnd);
    // ghostty-web's onRender never fires and onCursorMove only reports row changes, so
    // follow the cursor every frame. update() only writes styles that changed.
    window.requestAnimationFrame(this.tick);
  }

  private readonly tick = (): void => {
    window.requestAnimationFrame(this.tick);
    this.update();
  };

  /** Re-anchor the textarea (and the overlay, while composing). */
  update(): void {
    const spot = this.cursorSpot();
    const textarea = this.term.textarea;
    if (!spot || !textarea) return;
    const cell = this.cell();
    // ghostty-web's right-click copy flow repositions the textarea while it holds the
    // selection; leave it alone until that flow restores it.
    if (textarea.style.position === 'fixed' && textarea.style.pointerEvents === 'auto') return;
    if (textarea.style.position !== 'absolute') textarea.style.position = 'absolute';
    setPx(textarea, 'left', spot.left);
    setPx(textarea, 'top', spot.top);
    setPx(textarea, 'width', 1);
    setPx(textarea, 'height', cell.height);
    if (this.composing) this.placeOverlay(spot);
  }

  private readonly onFocusIn = (e: FocusEvent): void => {
    // The container is contenteditable; never let it hold focus, or the browser writes
    // composition text into it.
    if (e.target === this.container) this.term.textarea?.focus();
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.update();
  };

  private readonly onCompositionUpdate = (e: CompositionEvent): void => {
    this.composing = true;
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

  private placeOverlay(spot: CursorSpot): void {
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

  private cursorSpot(): CursorSpot | null {
    const canvas = this.terminalCanvas();
    if (!canvas) return null;
    const buf = this.term.buffer.active;
    return computeCursorSpot(
      { x: buf.cursorX, y: buf.cursorY },
      this.term.viewportY,
      { cols: this.term.cols, rows: this.term.rows },
      this.cell(),
      { left: canvas.offsetLeft, top: canvas.offsetTop },
    );
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
  prop: 'left' | 'top' | 'width' | 'height' | 'lineHeight' | 'maxWidth',
  value: number,
): void {
  const px = `${value}px`;
  if (el.style[prop] !== px) el.style[prop] = px;
}
