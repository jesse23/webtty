/**
 * Shows IME / dictation composition text at the terminal cursor (view, ADR 038).
 *
 * The vendored terminal keeps focus on its hidden textarea and anchors the textarea at
 * the cursor cell, so the OS dictation and candidate panels follow the cursor. The
 * textarea is clipped, so the composition itself is invisible; an overlay shows it over
 * the cursor cell in the theme's colours. Committed text still reaches the PTY through
 * ghostty-web's own compositionend handling.
 */

import { terminalCanvas } from '../../layout/terminal-canvas';
import { DisposableStore, listen } from '../../vendor/ghostty-web';
import { type OverlayBox, overlayBox } from './composer-geometry';

// ghostty-web's defaults for a theme without foreground/background.
const DEFAULT_FOREGROUND = '#d4d4d4';
const DEFAULT_BACKGROUND = '#1e1e1e';

/** The box's properties, in the order they are written. */
const BOX_PROPS = ['left', 'top', 'height', 'lineHeight', 'maxWidth'] as const;

/** The part of the terminal the overlay reads: the cursor cell, the font and the cell size. */
export interface ComposerTerminal {
  getCursorCellOffset(): { left: number; top: number } | undefined;
  readonly options: { fontFamily: string; fontSize: number };
  readonly renderer?: { getMetrics(): { width: number; height: number } | undefined };
}

/** The browser objects the overlay is built in and follows the cursor with. */
export interface ComposerDeps {
  document: Document;
  window: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>;
}

/** The composition overlay: follows the cursor every frame while a composition is open. */
export class Composer {
  private readonly overlay: HTMLDivElement;
  private readonly store = new DisposableStore();
  private composing = false;
  private frame = 0;

  constructor(
    private readonly term: ComposerTerminal,
    private readonly container: HTMLElement,
    private readonly theme: { foreground?: string; background?: string },
    private readonly deps: ComposerDeps = { document: container.ownerDocument, window },
  ) {
    const o = deps.document.createElement('div');
    this.overlay = o;
    o.dataset.compose = 'true';
    o.style.position = 'absolute';
    o.style.display = 'none';
    o.style.pointerEvents = 'none';
    o.style.whiteSpace = 'pre';
    o.style.overflow = 'hidden';
    o.style.zIndex = '10';
    o.style.textDecoration = 'underline';
    container.append(o);

    this.store.add(listen(container, 'compositionstart', this.onCompositionStart));
    this.store.add(listen(container, 'compositionupdate', this.onCompositionUpdate));
    this.store.add(listen(container, 'compositionend', this.onCompositionEnd));
    this.store.add(listen(container, 'focusout', this.onCompositionEnd));
  }

  // The terminal has no per-frame cursor event, so the overlay follows the cursor
  // every frame while composing. setPx only writes styles that changed.
  private readonly tick = (): void => {
    if (!this.composing) {
      this.frame = 0;
      return;
    }
    this.frame = this.deps.window.requestAnimationFrame(this.tick);
    this.update();
  };

  /** Re-place the overlay over the cursor cell. */
  update(): void {
    const spot = this.term.getCursorCellOffset();
    if (spot) this.placeOverlay(spot);
  }

  /** Removes the overlay and its listeners and stops following the cursor. Idempotent. */
  dispose(): void {
    if (this.store.isDisposed) return;
    this.store.dispose();
    this.composing = false;
    if (this.frame) this.deps.window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.overlay.remove();
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true;
    this.update();
    if (!this.frame) this.frame = this.deps.window.requestAnimationFrame(this.tick);
  };

  private readonly onCompositionUpdate = (e: CompositionEvent): void => {
    this.composing = true;
    if (!this.frame) this.frame = this.deps.window.requestAnimationFrame(this.tick);
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
    const canvas = terminalCanvas(this.container);
    const box = overlayBox(
      spot,
      this.cell(),
      canvas ? canvas.offsetLeft + canvas.offsetWidth : null,
    );
    for (const prop of BOX_PROPS) setPx(o, prop, box[prop]);
    o.style.fontFamily = this.term.options.fontFamily;
    o.style.fontSize = `${this.term.options.fontSize}px`;
    o.style.color = this.theme.foreground ?? DEFAULT_FOREGROUND;
    o.style.background = this.theme.background ?? DEFAULT_BACKGROUND;
  }

  private cell(): { width: number; height: number } {
    const metrics = this.term.renderer?.getMetrics();
    return { width: metrics?.width ?? 0, height: metrics?.height ?? 0 };
  }
}

function setPx(el: HTMLElement, prop: keyof OverlayBox, value: number): void {
  const px = `${value}px`;
  if (el.style[prop] !== px) el.style[prop] = px;
}
