// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// The DOM Terminal.open() builds and cleanupComponents takes down (util): the container's
// attributes, the canvas element, the hidden input textarea, the canvas's press-to-focus,
// and the element sizing and textarea anchoring done after (ADR 061, ADR 065).

import {
  type Disposable,
  DisposableStore,
  listen,
} from '../lifecycle/disposable-store';
import { mouseCursorFor, setStylePx } from './terminal-geometry';

/**
 * Makes the container focusable and contenteditable, so browser extensions (Vimium and
 * the like) treat it as an input and leave its keys alone, while the browser's own editing
 * of it is cancelled: input is handled by the terminal. The Disposable removes the
 * cancelling listener (ADR 065).
 */
export function makeContainerEditable(container: HTMLElement): Disposable {
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0');
  container.setAttribute('contenteditable', 'true');
  return listen(container, 'beforeinput', (e) => {
    if (e.target === container) e.preventDefault();
  });
}

/** The container's role and label for screen readers and extensions. */
export function labelContainer(container: HTMLElement): void {
  container.setAttribute('role', 'textbox');
  container.setAttribute('aria-label', 'Terminal input');
  container.setAttribute('aria-multiline', 'true');
}

/** Removes what the two functions above set, except the tabindex, as dispose always has. */
export function unlabelContainer(container: HTMLElement): void {
  container.removeAttribute('contenteditable');
  container.removeAttribute('role');
  container.removeAttribute('aria-label');
  container.removeAttribute('aria-multiline');
}

/**
 * The terminal's canvas element, a block with the default arrow cursor. It draws nothing
 * itself: the renderer draws on a canvas of its own (ADR 043).
 */
export function createTerminalCanvas(doc: Document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.cursor = mouseCursorFor(undefined);
  return canvas;
}

/**
 * The hidden textarea keyboard input goes to. It lives inside the container so its events
 * bubble there, and is clipped away, caret included, while staying focusable for mobile
 * keyboards.
 */
export function createInputTextarea(doc: Document): HTMLTextAreaElement {
  const textarea = doc.createElement('textarea');
  textarea.setAttribute('autocorrect', 'off');
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('spellcheck', 'false');
  textarea.setAttribute('tabindex', '0');
  textarea.setAttribute('aria-label', 'Terminal input');
  const style = textarea.style;
  style.position = 'absolute';
  style.left = '0';
  style.top = '0';
  style.width = '1px';
  style.height = '1px';
  style.padding = '0';
  style.border = 'none';
  style.margin = '0';
  style.opacity = '0';
  style.clipPath = 'inset(50%)';
  style.overflow = 'hidden';
  style.whiteSpace = 'nowrap';
  style.resize = 'none';
  return textarea;
}

/**
 * Focuses the textarea on a press (desktop) or a tap (mobile) on the canvas, with the
 * default prevented first; on iOS that keeps the native caret away. The Disposable removes
 * both listeners (ADR 065).
 */
export function focusTextareaOnPress(
  canvas: HTMLCanvasElement,
  textarea: HTMLTextAreaElement,
): Disposable {
  const listeners = new DisposableStore();
  listeners.add(
    listen(canvas, 'mousedown', (ev) => {
      ev.preventDefault();
      textarea.focus();
    }),
  );
  listeners.add(
    listen(canvas, 'touchend', (ev) => {
      ev.preventDefault();
      textarea.focus();
    }),
  );
  return listeners;
}

/** Sizes the canvas element to `cols` × `rows` cells of the renderer's metrics. */
export function sizeCanvasElement(
  canvas: HTMLCanvasElement,
  metrics: { width: number; height: number },
  cols: number,
  rows: number,
): void {
  canvas.style.width = `${metrics.width * cols}px`;
  canvas.style.height = `${metrics.height * rows}px`;
}

/**
 * Moves the textarea onto the cursor cell, one cell high, writing only styles that
 * changed. macOS places the dictation microphone and IME candidate window by its caret, so
 * it stays anchored before a composition starts too. (webtty)
 */
export function anchorTextarea(
  textarea: HTMLTextAreaElement,
  spot: { left: number; top: number },
  cellHeight: number,
): void {
  // The right-click copy flow repositions the textarea while it holds the selection;
  // leave it alone until that flow restores it.
  if (textarea.style.position === 'fixed' && textarea.style.pointerEvents === 'auto') return;
  if (textarea.style.position !== 'absolute') textarea.style.position = 'absolute';
  setStylePx(textarea, 'left', spot.left);
  setStylePx(textarea, 'top', spot.top);
  setStylePx(textarea, 'width', 1);
  setStylePx(textarea, 'height', cellHeight);
}
