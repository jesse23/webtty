// webtty (ADR 042, ADR 061), not from upstream.
// The key name tables (constants + util): ghostty-web's `Key` and `KeyEncoderOption`
// names that differ from libghostty-vt's, and the by-name translation of a TS enum to
// the official enum's values from the manifest.

import type { VtLayout } from './vt-layout';

/**
 * Ghostty's key names for the ghostty-web `Key` names that differ (ADR 042). Every
 * other `Key` keeps its name; values are always translated by name because 29 keys
 * have different numbers in the two builds.
 */
export const OFFICIAL_KEY_NAMES: Readonly<Record<string, string>> = {
  GRAVE: 'BACKQUOTE',
  ZERO: 'DIGIT_0',
  ONE: 'DIGIT_1',
  TWO: 'DIGIT_2',
  THREE: 'DIGIT_3',
  FOUR: 'DIGIT_4',
  FIVE: 'DIGIT_5',
  SIX: 'DIGIT_6',
  SEVEN: 'DIGIT_7',
  EIGHT: 'DIGIT_8',
  NINE: 'DIGIT_9',
  UP: 'ARROW_UP',
  DOWN: 'ARROW_DOWN',
  LEFT: 'ARROW_LEFT',
  RIGHT: 'ARROW_RIGHT',
  KP_0: 'NUMPAD_0',
  KP_1: 'NUMPAD_1',
  KP_2: 'NUMPAD_2',
  KP_3: 'NUMPAD_3',
  KP_4: 'NUMPAD_4',
  KP_5: 'NUMPAD_5',
  KP_6: 'NUMPAD_6',
  KP_7: 'NUMPAD_7',
  KP_8: 'NUMPAD_8',
  KP_9: 'NUMPAD_9',
  KP_PLUS: 'NUMPAD_ADD',
  KP_BACKSPACE: 'NUMPAD_BACKSPACE',
  KP_CLEAR: 'NUMPAD_CLEAR',
  KP_CLEAR_ENTRY: 'NUMPAD_CLEAR_ENTRY',
  KP_COMMA: 'NUMPAD_COMMA',
  KP_PERIOD: 'NUMPAD_DECIMAL',
  KP_DIVIDE: 'NUMPAD_DIVIDE',
  KP_ENTER: 'NUMPAD_ENTER',
  KP_EQUAL: 'NUMPAD_EQUAL',
  KP_MEMORY_ADD: 'NUMPAD_MEMORY_ADD',
  KP_MEMORY_CLEAR: 'NUMPAD_MEMORY_CLEAR',
  KP_MEMORY_RECALL: 'NUMPAD_MEMORY_RECALL',
  KP_MEMORY_STORE: 'NUMPAD_MEMORY_STORE',
  KP_MEMORY_SUBTRACT: 'NUMPAD_MEMORY_SUBTRACT',
  KP_MULTIPLY: 'NUMPAD_MULTIPLY',
  KP_PAREN_LEFT: 'NUMPAD_PAREN_LEFT',
  KP_PAREN_RIGHT: 'NUMPAD_PAREN_RIGHT',
  KP_MINUS: 'NUMPAD_SUBTRACT',
  KP_SEPARATOR: 'NUMPAD_SEPARATOR',
};

/** Ghostty's key encoder option names for the ghostty-web names that differ. */
export const OFFICIAL_ENCODER_OPTION_NAMES: Readonly<Record<string, string>> = {
  KITTY_KEYBOARD_FLAGS: 'KITTY_FLAGS',
};

/** Maps a numeric TS enum's values to the official enum's values, by name. */
export function translateEnum(
  ours: Record<string, string | number>,
  layout: VtLayout,
  official: string,
  renames: Readonly<Record<string, string>>
): Map<number, number> {
  const map = new Map<number, number>();
  for (const [name, value] of Object.entries(ours)) {
    if (typeof value !== 'number') continue;
    map.set(value, layout.value(official, renames[name] ?? name));
  }
  return map;
}
