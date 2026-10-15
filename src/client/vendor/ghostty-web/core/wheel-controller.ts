// Derived from coder/ghostty-web lib/terminal.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Wheel routing (controller): a wheel event goes to the embedder's handler, as scroll
// ticks to an app that tracks the mouse, or as arrow keys on the alternate screen, paced
// over frames (ADR 045, ADR 049). Moved out of terminal.ts (ADR 061).

import { AT_ONCE, type Pace } from '../glide';
import { mouseMods } from '../input/mouse-report';
import {
  type Disposable,
  DisposableStore,
  listen,
} from '../lifecycle/disposable-store';
import { TickPacer, type WheelAccumulator, wheelArrowKey, wheelArrows, wheelTicks } from '../wheel';
import type { WheelHost } from './host-types';
import { APP_CURSOR_KEYS_MODE } from './terminal-constants';

/** The cell height the arrow keys count by before the renderer exists. */
const FALLBACK_CELL_HEIGHT = 20;

/**
 * The container's capture wheel listener and where each event goes. The normal screen's
 * scrollback is scrolled by the custom handler (webtty's SmoothScroll, ADR 040, ADR 045);
 * upstream's easing here is removed.
 */
export class WheelController implements Disposable {
  private customHandler?: (event: WheelEvent) => boolean;
  private pace?: (event: WheelEvent) => Pace;
  private readonly tickTravel: WheelAccumulator = { accum: 0, dir: 0 };
  private readonly arrowTravel: WheelAccumulator = { accum: 0, dir: 0 };
  private listeners?: DisposableStore;

  /** `pacer` sends the ticks and arrows over frames; by default to `host.send`. */
  constructor(
    private readonly host: WheelHost,
    private readonly pacer: Pick<TickPacer, 'push' | 'cancel'> = new TickPacer((data) =>
      host.send(data),
    ),
  ) {}

  /** The embedder's handler, which takes an event by returning true. */
  setCustomHandler(handler?: (event: WheelEvent) => boolean): void {
    this.customHandler = handler;
  }

  /** How to pace the ticks of an event sent to the app; without it they go at once. */
  setPace(pace?: (event: WheelEvent) => Pace): void {
    this.pace = pace;
  }

  /**
   * Adds the wheel listener: capture, so it runs before the browser scrolls, and not
   * passive, so it can cancel a zoom.
   */
  attach(container: HTMLElement): void {
    this.listeners = new DisposableStore();
    this.listeners.add(
      listen(container, 'wheel', this.handle, { passive: false, capture: true }),
    );
  }

  /** Removes the listener and drops the queued ticks. Calling it again does nothing. */
  dispose(): void {
    this.pacer.cancel();
    this.listeners?.dispose();
  }

  /** Routes one wheel event. */
  readonly handle = (e: WheelEvent): void => {
    // Cancel only pinch and ctrl+wheel, which would zoom the page. A cancelled wheel
    // event makes Chrome hold the gesture's next event until the page has handled it,
    // which put scrolling about a frame behind native; nothing else on the page scrolls,
    // and overscroll-behavior stops rubber-banding and swipe-back. (webtty, ADR 045)
    if (e.ctrlKey) e.preventDefault();
    e.stopPropagation();

    if (this.customHandler && this.customHandler(e)) return;

    const engine = this.host.engine();
    // App tracks the mouse (e.g. vim `set mouse=a`): report scroll ticks as mouse
    // buttons 4/5 (SGR 64/65) at the cell under the pointer, on either screen.
    if (engine?.hasMouseTracking()) {
      this.sendTicks(e);
      return;
    }
    // Alternate screen (vim, less, htop): arrow keys to the application, one per line of
    // travel, paced like the ticks (webtty, ADR 045)
    if (engine?.isAlternateScreen() ?? false) this.sendArrows(e);
  };

  /**
   * One tick, a press of button 4 (up) or 5 (down) at the pointer's cell as Ghostty
   * encodes it, repeated by the pacer. Nothing in X10 mode 9. (webtty, ADR 049)
   */
  private sendTicks(e: WheelEvent): void {
    const host = this.host;
    const cellHeight = host.cellHeight();
    if (cellHeight === undefined || !host.hasCanvas()) return;
    const pace = this.pace?.(e) ?? AT_ONCE;
    const ticks = wheelTicks(this.tickTravel, e, cellHeight, host.mouseScrollSpeed());
    if (ticks === 0) return;
    const tick = host.encodeMouse({
      action: 'press',
      button: ticks < 0 ? 'four' : 'five',
      mods: mouseMods(e),
      clientX: e.clientX,
      clientY: e.clientY,
      anyButtonPressed: false,
    });
    if (tick) this.pacer.push(tick, Math.sign(ticks), Math.abs(ticks), pace);
  }

  /** Arrow keys for the travel, ESC O A/B under application cursor keys (DECCKM). */
  private sendArrows(e: WheelEvent): void {
    const host = this.host;
    const pace = this.pace?.(e) ?? AT_ONCE;
    const cellHeight = host.cellHeight() ?? FALLBACK_CELL_HEIGHT;
    const lines = wheelArrows(this.arrowTravel, e, cellHeight, host.rows());
    if (lines === 0) return;
    const dir = Math.sign(lines);
    const key = wheelArrowKey(dir, host.engine()?.getMode(APP_CURSOR_KEYS_MODE, false) ?? false);
    this.pacer.push(key, dir, Math.abs(lines), pace);
  }
}
