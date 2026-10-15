// Derived from coder/ghostty-web lib/input-handler.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Keyboard, IME and mouse input (facade): `InputHandler` owns the listeners on the
// container, the input element and the document, and hands each event to the key encoding,
// the text-input echo guard or the mouse reporter in input/ (ADR 047, ADR 049, ADR 061);
// dispose() removes every listener (ADR 065).
import type { KeyEncoder } from './engine/engine-types';
import type { Ghostty } from './ghostty';
import {
  encodeKeyPress,
  isPrintableKey,
  keyForCode,
  keyMods,
  plainKeySequence,
} from './input/key-encoding';
import { type MouseTrackingConfig, MouseReporter } from './input/mouse-report';
import { beforeInputText, EchoGuard, removeCompositionText } from './input/text-input';
import { DisposableStore, type ListenerTarget, listen } from './lifecycle/disposable-store';

export {
  MOUSE_BUTTONS,
  type MouseEventReport,
  type MouseTrackingConfig,
  motionButton,
  mouseMods,
} from './input/mouse-report';
export { plainKeySequence } from './input/key-encoding';

/** What the terminal sends input through; mouseReport is true for a mouse report (webtty, ADR 051). */
export type InputSink = (data: string, mouseReport?: boolean) => void;

/** What an InputHandler is built from. */
export interface InputHandlerOptions {
  /** Creates the key encoder (the Ghostty factory). */
  ghostty: Pick<Ghostty, 'createKeyEncoder'>;
  /** The element the keyboard, composition and press listeners go on. */
  container: HTMLElement;
  /** Receives terminal data (escape sequences to send to the PTY). */
  onData: InputSink;
  /** Reads a terminal mode; mode 1 (DECCKM) picks the cursor key sequences. */
  getMode?: (mode: number) => boolean;
  /** Copies the selection for Cmd+C; true when there was one. */
  onCopy?: () => boolean;
  /** The element whose beforeinput events carry IME and mobile text (the textarea). */
  inputElement?: HTMLElement;
  /** How mouse tracking is read and reports encoded; no reports without it. */
  mouseConfig?: MouseTrackingConfig;
  /** The echo guard's clock in ms; `performance.now()` by default. */
  now?: () => number;
}

/**
 * Attaches keyboard, IME and mouse listeners to a container and converts their events
 * to terminal input data.
 */
export class InputHandler {
  private readonly encoder: KeyEncoder;
  private readonly container: HTMLElement;
  private readonly onData: InputSink;
  private readonly getMode?: (mode: number) => boolean;
  private readonly onCopy?: () => boolean;
  private readonly mouse: MouseReporter;
  private readonly echoes: EchoGuard;
  private readonly listeners = new DisposableStore();
  private isComposing = false;

  constructor(options: InputHandlerOptions) {
    this.encoder = options.ghostty.createKeyEncoder();
    this.container = options.container;
    this.onData = options.onData;
    this.getMode = options.getMode;
    this.onCopy = options.onCopy;
    this.echoes = new EchoGuard(options.now);
    this.mouse = new MouseReporter(options.container, options.mouseConfig, options.onData);
    this.attach(options.inputElement);
  }

  /** Makes the container focusable and adds the listeners, in upstream's order. */
  private attach(inputElement: HTMLElement | undefined): void {
    const container = this.container;
    // Make container focusable so it can receive keyboard events (browser only)
    if (typeof container.hasAttribute === 'function' && typeof container.setAttribute === 'function') {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '0');
      // No default focus outline (only if style exists - for browser environments)
      if (container.style) container.style.outline = 'none';
    }
    // Move and release are heard on the document, so a drag keeps reporting past the
    // terminal's edge (webtty, ADR 049)
    const mouseTarget: ListenerTarget = container.ownerDocument ?? container;
    const store = this.listeners;
    store.add(listen(container, 'keydown', (e) => this.handleKeyDown(e)));
    // Paste is not handled here: webtty's capture listener on the container takes every
    // paste event first and sends it (ADR 037), and a cancelled paste fires no
    // insertFromPaste beforeinput. (webtty)
    if (inputElement) {
      store.add(listen(inputElement, 'beforeinput', (e) => this.handleBeforeInput(e)));
    }
    store.add(listen(container, 'compositionstart', () => this.handleCompositionStart()));
    // No compositionupdate listener: the browser's IME shows the text being composed, and
    // upstream's listened and did nothing (webtty, ADR 065)
    store.add(listen(container, 'compositionend', (e) => this.handleCompositionEnd(e)));
    store.add(listen(container, 'mousedown', (e) => this.mouse.down(e)));
    store.add(listen(mouseTarget, 'mouseup', (e) => this.mouse.up(e as MouseEvent)));
    store.add(listen(mouseTarget, 'mousemove', (e) => this.mouse.move(e as MouseEvent)));
    // Wheel input is the terminal's alone (the WheelController, paced). A listener here
    // also fired for a wheel over the padding, where the container itself is the target,
    // and sent that tick a second time, unpaced. (webtty)
  }

  /** Sends text typed or encoded from a keydown, and remembers it for the echo guard. */
  private sendKey(data: string): void {
    this.onData(data);
    this.echoes.recordKeyDown(data);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    // Ignore keydown events during composition
    // Note: Some browsers send keyCode 229 for all keys during composition
    if (this.isComposing || event.isComposing || event.keyCode === 229) return;

    // Ctrl+V and Cmd+V are not prevented, so the browser's paste event fires
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') return;

    // Cmd+C copies the selection (on Mac it should copy, not send an interrupt; Ctrl+C
    // sends 0x03 on every platform). With no selection it falls through to the browser,
    // which may have other text selected.
    if (event.metaKey && event.code === 'KeyC') {
      if (this.onCopy?.()) event.preventDefault();
      return;
    }

    // Printable characters without modifiers are sent as they are: a-z, A-Z (with
    // shift), 0-9, punctuation
    if (isPrintableKey(event)) {
      event.preventDefault();
      this.sendKey(event.key);
      return;
    }

    const key = keyForCode(event.code);
    if (key === null) return;
    const mods = keyMods(event);

    // The few keys the encoder does not send as xterm does; every other key, navigation
    // and function keys included, is encoded below, which follows the cursor key mode
    // and the modifiers (webtty)
    const plain = plainKeySequence(key, mods);
    if (plain !== null) {
      event.preventDefault();
      this.sendKey(plain);
      return;
    }

    try {
      const data = encodeKeyPress(this.encoder, key, mods, event.key, this.getMode?.(1));
      event.preventDefault();
      event.stopPropagation();
      if (data.length > 0) this.sendKey(data);
    } catch (error) {
      // Encoding failed - log but don't crash
      console.warn('Failed to encode key:', event.code, error);
    }
  }

  /** Mobile keyboards and IMEs: text, line breaks and deletes not seen as a keydown. */
  private handleBeforeInput(event: InputEvent): void {
    if (this.isComposing || event.isComposing) return;
    const data = event.data ?? '';
    const output = beforeInputText(event.inputType, data);
    if (!output) return;

    event.preventDefault();
    event.stopPropagation();
    // The same text a keydown or a composition just sent
    if (this.echoes.isKeyDownEcho(output)) return;
    if (data && this.echoes.isCompositionEcho(data)) return;

    this.onData(output);
    if (data) this.echoes.recordBeforeInput(data);
  }

  private handleCompositionStart(): void {
    this.isComposing = true;
  }

  private handleCompositionEnd(event: CompositionEvent): void {
    this.isComposing = false;
    const data = event.data;
    if (data && data.length > 0 && !this.echoes.isBeforeInputEcho(data)) {
      this.onData(data);
      this.echoes.recordComposition(data);
    }
    removeCompositionText(this.container);
  }

  /** Removes every listener; a second call does nothing. */
  dispose(): void {
    this.listeners.dispose();
  }
}
