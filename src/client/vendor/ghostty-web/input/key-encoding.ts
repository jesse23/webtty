// Derived from coder/ghostty-web lib/input-handler.ts (MIT, see LICENSE and PROVENANCE.md in ghostty-web/).
// Key encoding (util): what a keydown sends, from the DOM event to the bytes, through the
// key table and Ghostty's key encoder; the InputHandler decides when to call it (ADR 047,
// ADR 061).

import type { KeyEncoder } from '../engine/engine-types';
import { KEY_MAP } from './key-map';
import { Key, KeyAction, KeyEncoderOption, Mods } from './key-types';

/** The parts of a keydown the encoding reads, so tests pass plain objects. */
export type KeyEventFields = Pick<
  KeyboardEvent,
  'key' | 'code' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
>;

/** The Ghostty key for a `KeyboardEvent.code`, or null for a key the table does not know. */
export function keyForCode(code: string): Key | null {
  return KEY_MAP[code] ?? null;
}

/**
 * The modifier flags of a key event. CapsLock and NumLock are not in KeyboardEvent's
 * modifiers, so they are never set.
 */
export function keyMods(event: KeyEventFields): Mods {
  let mods = Mods.NONE;
  if (event.shiftKey) mods |= Mods.SHIFT;
  if (event.ctrlKey) mods |= Mods.CTRL;
  if (event.altKey) mods |= Mods.ALT;
  if (event.metaKey) mods |= Mods.SUPER;
  return mods;
}

/**
 * Whether a key types its character as it is: one character, and no Ctrl, Alt or Meta
 * (Cmd on Mac), except Ctrl+Alt, which is AltGr on some keyboards and types characters.
 */
export function isPrintableKey(event: KeyEventFields): boolean {
  if (event.ctrlKey && !event.altKey) return false;
  if (event.altKey && !event.ctrlKey) return false;
  if (event.metaKey) return false;
  return event.key.length === 1;
}

/**
 * The sequence for a key the official encoder does not send as xterm does, or null to
 * encode the key. For Shift+Enter and Shift+Escape the encoder sends Ghostty's
 * modifyOtherKeys `CSI 27;2;13~` and `CSI 27;2;27~`, which most apps do not read; xterm
 * sends CR and ESC, as upstream did. Every other key is encoded: navigation and function
 * keys follow the cursor key mode (Home is `ESC O H` under DECCKM) and the modifiers
 * (Shift+Home is `CSI 1;2 H`). (webtty: upstream sent a fixed table for Enter, Tab,
 * Backspace, Escape, the navigation keys and F1-F12, unmodified or with Shift, which
 * ignored both.)
 */
export function plainKeySequence(key: Key, mods: Mods): string | null {
  if (mods !== Mods.SHIFT) return null;
  if (key === Key.ENTER) return '\r';
  if (key === Key.ESCAPE) return '\x1b';
  return null;
}

/**
 * The text the encoder is given with a key: the lowercase base character of an ASCII
 * key, even with modifiers, so Ctrl+A encodes as 0x01; none for Enter, the arrows and
 * the other named keys.
 */
export function encoderText(eventKey: string): string | undefined {
  return eventKey.length === 1 && eventKey.charCodeAt(0) < 128 ? eventKey.toLowerCase() : undefined;
}

/**
 * Encodes a key press with Ghostty's encoder and returns the text to send ('' for none).
 * `appCursor` is DEC mode 1 (DECCKM), which picks CSI or SS3 for the cursor keys; when
 * it is undefined the encoder keeps its option as it is. The encoder may throw.
 */
export function encodeKeyPress(
  encoder: KeyEncoder,
  key: Key,
  mods: Mods,
  eventKey: string,
  appCursor: boolean | undefined,
): string {
  if (appCursor !== undefined) {
    encoder.setOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, appCursor);
  }
  const encoded = encoder.encode({ action: KeyAction.PRESS, key, mods, utf8: encoderText(eventKey) });
  return new TextDecoder().decode(encoded);
}
