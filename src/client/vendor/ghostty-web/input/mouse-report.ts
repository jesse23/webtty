// Derived from coder/ghostty-web lib/input-handler.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Mouse reports to the app (object): MouseReporter keeps the buttons held and the ones
// webtty took (Shift), and sends each press, release and motion as Ghostty's mouse
// encoder reports it (ADR 049, ADR 051, ADR 061).

import type { MouseButton, MouseInput } from '../engine/engine-types';
import { pressToApp } from '../mouse-route';
import { Mods } from './key-types';

/** A mouse event to report, at a client (viewport) position. (webtty, ADR 049) */
export type MouseEventReport = Omit<MouseInput, 'x' | 'y'> & { clientX: number; clientY: number };

/** How the terminal's mouse tracking is read and its reports encoded. */
export interface MouseTrackingConfig {
  /** Check if any mouse tracking mode is enabled */
  hasMouseTracking: () => boolean;
  /**
   * The report for a mouse event at a client position, encoded by Ghostty's mouse
   * encoder in the app's tracking mode and format, or '' when the app does not get one.
   * (webtty: upstream encoded SGR or X10 itself, ADR 049)
   */
  encode: (event: MouseEventReport) => string;
}

/**
 * Ghostty's button for `MouseEvent.button`: 0 left, 1 middle, 2 right, and 3/4 back
 * and forward, which Ghostty reports as buttons 8/9 (codes 128/129). (webtty: upstream
 * sent `MouseEvent.button` as the code, so back was a release and forward Shift.)
 */
export const MOUSE_BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right', 'eight', 'nine'];

/**
 * The button a motion report carries, from the pressed-button bitmask (bit n is
 * `MouseEvent.button` n): the lowest one held, or none, which Ghostty reports as 35.
 * (webtty: upstream sent 32 for hover, the same code as a left-button drag.)
 */
export function motionButton(pressed: number): MouseButton | null {
  for (let i = 0; i < MOUSE_BUTTONS.length; i++) {
    if (pressed & (1 << i)) return MOUSE_BUTTONS[i];
  }
  return null;
}

/**
 * The modifiers of a mouse event. Ghostty reports Shift (+4), Alt (+8) and Ctrl (+16),
 * not Super. (webtty: upstream sent Meta as +8 and dropped Alt.)
 */
export function mouseMods(
  e: Pick<MouseEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>,
): number {
  return (
    (e.shiftKey ? Mods.SHIFT : 0) |
    (e.altKey ? Mods.ALT : 0) |
    (e.ctrlKey ? Mods.CTRL : 0) |
    (e.metaKey ? Mods.SUPER : 0)
  );
}

/** What the reporter needs from the terminal's container. */
export type MouseContainer = Pick<HTMLElement, 'contains'>;

/**
 * Turns the container's presses and the document's moves and releases into mouse
 * reports while the app tracks the mouse. Ghostty decides what is reported: the
 * tracking mode (presses only in X10 mode 9, no motion in 1000, motion with a button in
 * 1002), motion once per cell, the padding as the nearest edge cell, and motion outside
 * the terminal only while a button is held. (webtty, ADR 049)
 */
export class MouseReporter {
  private pressed = 0;
  // Buttons pressed with Shift while the app tracks the mouse: webtty's (selection, menu),
  // so nothing about them reaches the app until they are released (webtty, ADR 051)
  private bypassed = 0;

  /** `send` gets each report with mouseReport true, which leaves the selection alone (webtty, ADR 051). */
  constructor(
    private readonly container: MouseContainer,
    private readonly config: MouseTrackingConfig | undefined,
    private readonly send: (data: string, mouseReport: true) => void,
  ) {}

  /** A press on the terminal. Selection is left to the SelectionManager: nothing is prevented but back and forward. */
  down(event: MouseEvent): void {
    const tracking = this.config?.hasMouseTracking() ?? false;
    if (!tracking) return;
    const button = MOUSE_BUTTONS[event.button];
    if (!button) return;
    // Shift+press is webtty's: the app gets neither it, the drag nor the release
    // (webtty, ADR 051)
    if (!pressToApp(tracking, event.shiftKey)) {
      this.bypassed |= 1 << event.button;
      return;
    }
    // Back and forward would leave the session's page (webtty)
    if (event.button >= 3) event.preventDefault();
    this.pressed |= 1 << event.button;
    this.report(event, 'press', button);
  }

  /**
   * A release anywhere in the document: outside the terminal only for a button pressed
   * in it (webtty: upstream lost a release outside the container)
   */
  up(event: MouseEvent): void {
    if (!this.config?.hasMouseTracking()) return;
    const button = MOUSE_BUTTONS[event.button];
    if (!button) return;
    const bit = 1 << event.button;
    if (this.bypassed & bit) {
      this.bypassed &= ~bit;
      return;
    }
    if (!(this.pressed & bit) && !this.isOverTerminal(event)) return;
    if (event.button >= 3) event.preventDefault();
    this.pressed &= ~bit;
    this.report(event, 'release', button);
  }

  /**
   * A move anywhere in the document: outside the terminal only while a button pressed in
   * it is held, so a drag past the edge keeps reporting (webtty)
   */
  move(event: MouseEvent): void {
    if (!this.config?.hasMouseTracking()) return;
    // No button held: a release outside the document never cleared the bitmask
    if (event.buttons === 0) {
      this.pressed = 0;
      this.bypassed = 0;
    }
    // A Shift drag is webtty's selection (webtty, ADR 051)
    if (this.bypassed !== 0) return;
    if (this.pressed === 0 && !this.isOverTerminal(event)) return;
    this.report(event, 'motion', motionButton(this.pressed));
  }

  /** Whether a mouse event is over the terminal (the container or what is in it). */
  private isOverTerminal(event: MouseEvent): boolean {
    const target = event.target as Node | null;
    return !!target && (target === this.container || !!this.container.contains?.(target));
  }

  private report(event: MouseEvent, action: MouseInput['action'], button: MouseButton | null) {
    const data = this.config?.encode({
      action,
      button,
      mods: mouseMods(event),
      clientX: event.clientX,
      clientY: event.clientY,
      anyButtonPressed: this.pressed !== 0,
    });
    if (data) this.send(data, true);
  }
}
